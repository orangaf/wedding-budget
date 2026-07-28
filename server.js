/**
 * server.js — מאזן החתונה (Cloud Version)
 * Express REST API + Telegram Webhook + Gemini AI + Supabase
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const multer   = require('multer');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

/* ─────────────────────────────────────────
   ENV / הגדרות
───────────────────────────────────────── */
const TOKEN          = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL   || 'https://twprvzxdmfxjhinwarpo.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const PORT           = process.env.PORT            || 3001;
const WEBHOOK_URL    = process.env.WEBHOOK_URL     || ''; // e.g. https://my-app.onrender.com
const IS_PRODUCTION  = !!process.env.WEBHOOK_URL;

/* ─────────────────────────────────────────
   Supabase Client
───────────────────────────────────────── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ─────────────────────────────────────────
   AI Setup (Gemini)
───────────────────────────────────────── */
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const schema = {
  type: SchemaType.OBJECT,
  properties: {
    action: { type: SchemaType.STRING, description: 'One of: ADD_EXPENSE, ADD_GIFT, QUERY, UNKNOWN' },
    expense: {
      type: SchemaType.OBJECT,
      properties: {
        name:   { type: SchemaType.STRING },
        cat:    { type: SchemaType.STRING, description: 'Must be exactly one of: אולם, קייטרינג, צילום ווידאו, מוזיקה, פרחים, שמלה וחליפה, הזמנות, הסעות, ירח דבש, אחר' },
        amount: { type: SchemaType.NUMBER },
        status: { type: SchemaType.STRING, description: 'Must be exactly one of: מתוכנן, שולם מקדמה, שולם במלואו' },
        note:   { type: SchemaType.STRING }
      }
    },
    gift: {
      type: SchemaType.OBJECT,
      properties: {
        name:   { type: SchemaType.STRING },
        guests: { type: SchemaType.NUMBER },
        amount: { type: SchemaType.NUMBER },
        side:   { type: SchemaType.STRING, description: 'Must be exactly one of: חתן, כלה, משותף' },
        note:   { type: SchemaType.STRING }
      }
    },
    replyText: { type: SchemaType.STRING }
  },
  required: ['action', 'replyText']
};
const aiModel = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: { responseMimeType: 'application/json', responseSchema: schema }
});

/* ─────────────────────────────────────────
   Supabase DB helpers
───────────────────────────────────────── */
async function readData() {
  const [{ data: expenses }, { data: gifts }] = await Promise.all([
    supabase.from('expenses').select('*').order('date', { ascending: false }),
    supabase.from('gifts').select('*')
  ]);
  return { expenses: expenses || [], gifts: gifts || [] };
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function fmt(n) { return '₪' + Number(n || 0).toLocaleString('he-IL'); }

/* ─────────────────────────────────────────
   Multer — העלאת קבצים לזיכרון (לשליחה לSupabase)
───────────────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf', '.heic', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

/* ─────────────────────────────────────────
   Express
───────────────────────────────────────── */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── GET כל הנתונים ── */
app.get('/api/data', async (req, res) => {
  try { res.json(await readData()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── ייצוא CSV הוצאות ── */
app.get('/api/export/expenses.csv', async (req, res) => {
  const { expenses } = await readData();
  const BOM    = '\uFEFF';
  const header = 'שם הוצאה,קטגוריה,סכום,סטטוס,הערה,תאריך,קבלה\n';
  const rows   = expenses.map(e => {
    const receiptUrl = e.receipt ? `${SUPABASE_URL}/storage/v1/object/public/receipts/${e.receipt}` : '';
    return [e.name, e.cat, e.amount, e.status, e.note || '', e.date || '', receiptUrl]
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',');
  }).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wedding-expenses.csv"');
  res.send(BOM + header + rows);
});

/* ── ייצוא CSV אורחים ── */
app.get('/api/export/guests.csv', async (req, res) => {
  const { gifts } = await readData();
  const BOM    = '\uFEFF';
  const header = 'שם אורח,צד,מספר אנשים,סכום מעטפה,ממוצע לאיש,הערה\n';
  const rows   = gifts.map(g => {
    const avg = g.guests > 0 ? (g.amount / g.guests).toFixed(0) : 0;
    return [g.name, g.side, g.guests, g.amount, avg, g.note || '']
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',');
  }).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wedding-guests.csv"');
  res.send(BOM + header + rows);
});

/* ── CRUD הוצאות ── */
app.post('/api/expenses', async (req, res) => {
  const exp = { id: uid(), date: new Date().toLocaleDateString('he-IL'), receipt: '', ...req.body };
  const { data, error } = await supabase.from('expenses').insert(exp).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/expenses/:id', async (req, res) => {
  const { data, error } = await supabase.from('expenses').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/expenses/:id', async (req, res) => {
  // Delete receipt from storage if exists
  const { data: exp } = await supabase.from('expenses').select('receipt').eq('id', req.params.id).single();
  if (exp?.receipt) await supabase.storage.from('receipts').remove([exp.receipt]);
  await supabase.from('expenses').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

/* ── העלאת קבלה ── */
app.post('/api/expenses/:id/receipt', upload.single('receipt'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext      = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const filename = `receipt_${req.params.id}_${Date.now()}${ext}`;

  // Remove old receipt
  const { data: exp } = await supabase.from('expenses').select('receipt').eq('id', req.params.id).single();
  if (exp?.receipt) await supabase.storage.from('receipts').remove([exp.receipt]);

  // Upload to Supabase Storage
  const { error: upErr } = await supabase.storage.from('receipts').upload(filename, req.file.buffer, {
    contentType: req.file.mimetype,
    upsert: true
  });
  if (upErr) return res.status(500).json({ error: upErr.message });

  await supabase.from('expenses').update({ receipt: filename }).eq('id', req.params.id);
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/receipts/${filename}`;
  res.json({ filename, url: publicUrl });
});

/* ── מחיקת קבלה ── */
app.delete('/api/expenses/:id/receipt', async (req, res) => {
  const { data: exp } = await supabase.from('expenses').select('receipt').eq('id', req.params.id).single();
  if (exp?.receipt) {
    await supabase.storage.from('receipts').remove([exp.receipt]);
    await supabase.from('expenses').update({ receipt: '' }).eq('id', req.params.id);
  }
  res.json({ ok: true });
});

/* ── CRUD מעטפות ── */
app.post('/api/gifts', async (req, res) => {
  const gift = { id: uid(), ...req.body };
  const { data, error } = await supabase.from('gifts').insert(gift).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/gifts/:id', async (req, res) => {
  const { data, error } = await supabase.from('gifts').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/gifts/:id', async (req, res) => {
  await supabase.from('gifts').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

/* ── Health check (Render needs this to keep alive) ── */
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

/* ── Telegram Webhook endpoint ── */
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  bot.processUpdate(req.body);
});

/* ─────────────────────────────────────────
   Telegram Bot
───────────────────────────────────────── */
const bot = IS_PRODUCTION
  ? new TelegramBot(TOKEN) // webhook mode — no polling
  : new TelegramBot(TOKEN, { polling: true }); // local dev mode

const userState  = {};
const lastExpId  = {};

function stateKey(msg)                { return `${msg.chat.id}_${msg.from?.id || msg.chat.id}`; }
function getState(msg)                { return userState[stateKey(msg)] || { step: 'idle', data: {} }; }
function setState(msg, step, data={}) { userState[stateKey(msg)] = { step, data }; }
function clearState(msg)              { delete userState[stateKey(msg)]; }

const CATEGORIES = ['אולם','קייטרינג','צילום ווידאו','מוזיקה','פרחים','שמלה וחליפה','הזמנות','הסעות','ירח דבש','אחר'];
const CAT_EMOJI  = {'אולם':'🏛️','קייטרינג':'🍽️','צילום ווידאו':'📸','מוזיקה':'🎵','פרחים':'🌸','שמלה וחליפה':'👗','הזמנות':'💌','הסעות':'🚌','ירח דבש':'✈️','אחר':'📦'};
const STATUSES   = ['מתוכנן','שולם מקדמה','שולם במלואו'];
const SIDES      = ['חתן','כלה','משותף'];

function catKeyboard()    { const r=[]; for(let i=0;i<CATEGORIES.length;i+=2){r.push(CATEGORIES.slice(i,i+2).map(c=>({text:`${CAT_EMOJI[c]} ${c}`,callback_data:'cat:'+c})));} return {inline_keyboard:r}; }
function statusKeyboard() { return {inline_keyboard:[STATUSES.map(s=>({text:s,callback_data:'status:'+s}))]}; }
function sideKeyboard()   { return {inline_keyboard:[SIDES.map(s=>({text:s,callback_data:'side:'+s}))]}; }

function mainMenu(chatId) {
  bot.sendMessage(chatId,
    `💍 *מאזן החתונה* — תפריט ראשי\n\n` +
    `💡 פשוט כתבו לי בשפה חופשית!\nלמשל: _"שילמנו 5000 לצלם"_\n\n` +
    `📸 *לצירוף קבלה* — שלחו תמונה/PDF אחרי הוספת הוצאה\n\n` +
    `פקודות מהירות:\n` +
    `📊 /סיכום  💸 /הוצאה  🎁 /אורח\n` +
    `📋 /רשימה  📑 /אורחים  ❌ /ביטול`,
    { parse_mode: 'Markdown' }
  );
}

/* ── פקודות ── */
bot.onText(/\/start/, (msg) => { clearState(msg); mainMenu(msg.chat.id); });
bot.onText(/\/help/,  (msg) => { clearState(msg); mainMenu(msg.chat.id); });
bot.onText(/\/ביטול/, (msg) => { clearState(msg); bot.sendMessage(msg.chat.id, '❌ הפעולה בוטלה.'); });
bot.onText(/\/הוצאה/, (msg) => { setState(msg,'expense_name',{}); bot.sendMessage(msg.chat.id,'💸 *הוספת הוצאה חדשה*\n\nמה שם ההוצאה?',{parse_mode:'Markdown'}); });
bot.onText(/\/אורח/,  (msg) => { setState(msg,'gift_name',{});    bot.sendMessage(msg.chat.id,'🎁 *הוספת אורח / מעטפה*\n\nמה שם האורח?',{parse_mode:'Markdown'}); });

bot.onText(/\/סיכום/, async (msg) => {
  clearState(msg);
  try {
    const data      = await readData();
    const totalExp  = data.expenses.reduce((s,e)=>s+(Number(e.amount)||0),0);
    const totalGift = data.gifts.reduce((s,g)=>s+(Number(g.amount)||0),0);
    const totalPpl  = data.gifts.reduce((s,g)=>s+(Number(g.guests)||0),0);
    const balance   = totalGift - totalExp;
    const pct       = totalExp>0 ? ((totalGift/totalExp)*100).toFixed(1) : '0.0';
    const catMap    = {};
    data.expenses.forEach(e=>{catMap[e.cat]=(catMap[e.cat]||0)+Number(e.amount);});
    const catLines  = Object.entries(catMap).sort((a,b)=>b[1]-a[1]).map(([c,a])=>`   ${CAT_EMOJI[c]||'📦'} ${c}: *${fmt(a)}*`).join('\n');
    const recCount  = data.expenses.filter(e=>e.receipt).length;
    bot.sendMessage(msg.chat.id,
      `📊 *לוח בקרה — מאזן החתונה*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `💸 סה"כ הוצאות: *${fmt(totalExp)}*\n` +
      `🎁 סה"כ מעטפות: *${fmt(totalGift)}*\n` +
      `👥 מספר אורחים: *${totalPpl}*\n` +
      `🧾 קבלות שמורות: *${recCount}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${balance>=0?'✅ רווח':'⚠️ הפסד'}: *${fmt(Math.abs(balance))}*\n` +
      `📈 כיסוי הוצאות: *${pct}%*\n` +
      (catLines?`━━━━━━━━━━━━━━━━━━━━\n📂 *פירוט:*\n${catLines}\n`:'') +
      `━━━━━━━━━━━━━━━━━━━━`,
      {parse_mode:'Markdown'}
    );
  } catch(e) { bot.sendMessage(msg.chat.id,'❌ שגיאה בטעינת הנתונים'); }
});

bot.onText(/\/רשימה/, async (msg) => {
  clearState(msg);
  const {expenses} = await readData();
  if (!expenses.length) return bot.sendMessage(msg.chat.id,'📋 עדיין אין הוצאות רשומות.');
  const lines = expenses.map((e,i)=>`${i+1}. *${e.name}* — ${fmt(e.amount)}\n   ${CAT_EMOJI[e.cat]||'📦'} ${e.cat} | ${e.status}${e.receipt?' 🧾':''}`).join('\n\n');
  const total = expenses.reduce((s,e)=>s+Number(e.amount),0);
  bot.sendMessage(msg.chat.id,`📋 *רשימת הוצאות (${expenses.length})*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\n💰 סה"כ: *${fmt(total)}*`,{parse_mode:'Markdown'});
});

bot.onText(/\/אורחים/, async (msg) => {
  clearState(msg);
  const {gifts} = await readData();
  if (!gifts.length) return bot.sendMessage(msg.chat.id,'🎁 עדיין אין אורחים רשומים.');
  const lines = gifts.map((g,i)=>{
    const avg=g.guests>0?(Number(g.amount)/Number(g.guests)).toFixed(0):0;
    return `${i+1}. *${g.name}* — ${fmt(g.amount)}\n   👥 ${g.guests} | ${g.side} | ממוצע: ${fmt(avg)}`;
  }).join('\n\n');
  const totalAmt=gifts.reduce((s,g)=>s+Number(g.amount),0);
  const totalPpl=gifts.reduce((s,g)=>s+Number(g.guests),0);
  bot.sendMessage(msg.chat.id,`🎁 *רשימת אורחים (${gifts.length})*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\n💌 סה"כ: *${fmt(totalAmt)}* | 👥 *${totalPpl}*`,{parse_mode:'Markdown'});
});

/* ── AI — שפה חופשית ── */
async function processNaturalLanguage(msg) {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');
  try {
    const data = await readData();
    const totalExp  = data.expenses.reduce((s,e)=>s+(Number(e.amount)||0),0);
    const totalGift = data.gifts.reduce((s,g)=>s+(Number(g.amount)||0),0);
    const prompt = `
    You are a helpful wedding budget assistant bot on Telegram.
    Analyze this user message: "${msg.text.trim()}"
    Context: Total Expenses ₪${totalExp}, Total Gifts ₪${totalGift}, Balance ₪${totalGift-totalExp}
    Determine intent: ADD_EXPENSE (spent/planned), ADD_GIFT (envelope from guest), QUERY (question/greeting), UNKNOWN.
    Reply in friendly Hebrew with emojis. Output JSON.`;
    const result = await aiModel.generateContent(prompt);
    const parsed = JSON.parse(result.response.text());
    if (parsed.action==='ADD_EXPENSE' && parsed.expense) {
      const exp=parsed.expense;
      if(!exp.name) exp.name='הוצאה כללית';
      if(!CATEGORIES.includes(exp.cat)) exp.cat='אחר';
      if(!STATUSES.includes(exp.status)) exp.status='שולם במלואו';
      const savedId = await _saveExpense(msg, exp, true);
      if (savedId) lastExpId[chatId] = { id: savedId, ts: Date.now() };
      bot.sendMessage(chatId, parsed.replyText + '\n\n📸 _רוצים לצרף קבלה? שלחו תמונה עכשיו!_', {parse_mode:'Markdown'});
    } else if (parsed.action==='ADD_GIFT' && parsed.gift) {
      const g=parsed.gift;
      if(!g.name) g.name='אורח לא ידוע';
      if(!SIDES.includes(g.side)) g.side='משותף';
      await _saveGift(msg, g, true);
      bot.sendMessage(chatId, parsed.replyText);
    } else {
      bot.sendMessage(chatId, parsed.replyText);
    }
  } catch(err) {
    console.error('AI Error:', err.message);
    bot.sendMessage(chatId, 'מצטער, הייתה לי שגיאה... תנסו שוב? 😅');
  }
}

/* ── קבלות מטלגרם ── */
async function handleReceiptMedia(msg, fileId) {
  const chatId  = msg.chat.id;
  const caption = (msg.caption || '').toLowerCase();
  let targetExp = null;

  if (caption && !['קבלה','חשבונית','receipt'].some(k=>caption.includes(k))) {
    const {expenses} = await readData();
    targetExp = expenses.find(e => caption.includes(e.name.toLowerCase()));
  }

  if (!targetExp && lastExpId[chatId]) {
    const { id, ts } = lastExpId[chatId];
    if (Date.now() - ts < 10 * 60 * 1000) {
      const {expenses} = await readData();
      targetExp = expenses.find(e => e.id === id);
    }
  }

  if (!targetExp) {
    const {expenses} = await readData();
    if (!expenses.length) return bot.sendMessage(chatId,'❌ אין הוצאות רשומות עדיין.');
    const recent = expenses.slice(0,5);
    const keyboard = recent.map(e=>[{text:`${CAT_EMOJI[e.cat]||'📦'} ${e.name} — ${fmt(e.amount)}`,callback_data:`receipt_attach:${e.id}`}]);
    keyboard.push([{text:'❌ ביטול',callback_data:'receipt_cancel'}]);
    userState[`receipt_pending_${chatId}`] = { fileId };
    return bot.sendMessage(chatId,'🧾 *לאיזו הוצאה לצרף?*',{parse_mode:'Markdown',reply_markup:{inline_keyboard:keyboard}});
  }

  await saveReceiptFromTelegram(chatId, fileId, targetExp);
}

async function saveReceiptFromTelegram(chatId, fileId, targetExp) {
  try {
    bot.sendChatAction(chatId, 'upload_photo');
    const fileInfo  = await bot.getFile(fileId);
    const fileUrl   = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
    const ext       = path.extname(fileInfo.file_path) || '.jpg';
    const filename  = `receipt_${targetExp.id}_${Date.now()}${ext}`;

    const response  = await fetch(fileUrl);
    const buffer    = Buffer.from(await response.arrayBuffer());

    if (targetExp.receipt) await supabase.storage.from('receipts').remove([targetExp.receipt]);

    await supabase.storage.from('receipts').upload(filename, buffer, { contentType: 'image/jpeg', upsert: true });
    await supabase.from('expenses').update({ receipt: filename }).eq('id', targetExp.id);
    delete lastExpId[chatId];

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/receipts/${filename}`;
    bot.sendMessage(chatId,
      `✅ *הקבלה נשמרה בהצלחה!*\n\n🧾 צורפה ל: *${targetExp.name}*\n🌐 [צפו בקבלה](${publicUrl})`,
      {parse_mode:'Markdown', disable_web_page_preview: false}
    );
  } catch(err) {
    console.error('Receipt error:', err);
    bot.sendMessage(chatId,'❌ שגיאה בשמירת הקבלה.');
  }
}

bot.on('photo',    (msg) => handleReceiptMedia(msg, msg.photo[msg.photo.length-1].file_id));
bot.on('document', (msg) => {
  const allowed = ['image/jpeg','image/png','image/webp','application/pdf','image/heic'];
  if (!allowed.includes(msg.document?.mime_type)) return bot.sendMessage(msg.chat.id,'⚠️ שלחו תמונה (JPG/PNG) או PDF בלבד.');
  handleReceiptMedia(msg, msg.document.file_id);
});

/* ── State Machine ── */
bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text   = msg.text.trim();
  const state  = getState(msg);
  switch(state.step) {
    case 'expense_name': setState(msg,'expense_cat',{name:text}); bot.sendMessage(chatId,`✏️ שם: *${text}*\n\nבחרו קטגוריה:`,{parse_mode:'Markdown',reply_markup:catKeyboard()}); break;
    case 'expense_amount': {
      const amount=parseFloat(text.replace(/[^0-9.]/g,''));
      if(isNaN(amount)||amount<0) return bot.sendMessage(chatId,'⚠️ הזינו מספר תקין');
      setState(msg,'expense_status',{...state.data,amount});
      bot.sendMessage(chatId,`💰 ${fmt(amount)}\n\nמה הסטטוס?`,{parse_mode:'Markdown',reply_markup:statusKeyboard()});
      break;
    }
    case 'expense_note': { const note=text==='-'?'':text; _saveExpense(msg,{...state.data,note}).then(id=>{if(id) lastExpId[chatId]={id,ts:Date.now()};}); break; }
    case 'gift_name': setState(msg,'gift_guests',{name:text}); bot.sendMessage(chatId,`👤 *${text}*\n\nכמה אנשים?`,{parse_mode:'Markdown'}); break;
    case 'gift_guests': setState(msg,'gift_amount',{...state.data,guests:parseInt(text)||1}); bot.sendMessage(chatId,'כמה במעטפה? (₪)'); break;
    case 'gift_amount': setState(msg,'gift_side',{...state.data,amount:parseFloat(text.replace(/[^0-9.]/g,''))||0}); bot.sendMessage(chatId,'צד מי?',{reply_markup:sideKeyboard()}); break;
    case 'gift_note': _saveGift(msg,{...state.data,note:text==='-'?'':text}); break;
    default: processNaturalLanguage(msg);
  }
});

/* ── Callback Queries ── */
bot.on('callback_query', async (query) => {
  const fakeMsg = {chat:query.message.chat,from:query.from,text:''};
  const chatId  = query.message.chat.id;
  const data_   = query.data;
  const state   = getState(fakeMsg);
  bot.answerCallbackQuery(query.id);

  if (data_.startsWith('receipt_attach:')) {
    const expId   = data_.slice(15);
    const pending = userState[`receipt_pending_${chatId}`];
    if (!pending) return bot.sendMessage(chatId,'❌ פג תוקף.');
    delete userState[`receipt_pending_${chatId}`];
    const {expenses} = await readData();
    const exp = expenses.find(e=>e.id===expId);
    if (!exp) return bot.sendMessage(chatId,'❌ הוצאה לא נמצאה.');
    await saveReceiptFromTelegram(chatId, pending.fileId, exp);
    return;
  }
  if (data_==='receipt_cancel') { delete userState[`receipt_pending_${chatId}`]; bot.sendMessage(chatId,'❌ בוטל.'); return; }
  if (data_.startsWith('cat:'))    { const cat=data_.slice(4);    if(state.step!=='expense_cat')    return; setState(fakeMsg,'expense_amount',{...state.data,cat});    bot.sendMessage(chatId,`📂 ${CAT_EMOJI[cat]||''} ${cat}\n\nכמה עולה? (₪)`,{parse_mode:'Markdown'}); }
  if (data_.startsWith('status:')) { const status=data_.slice(7); if(state.step!=='expense_status') return; setState(fakeMsg,'expense_note',{...state.data,status});   bot.sendMessage(chatId,`📌 ${status}\n\nהערה (שלחו \`-\` אם אין)`,{parse_mode:'Markdown'}); }
  if (data_.startsWith('side:'))   { const side=data_.slice(5);   if(state.step!=='gift_side')      return; setState(fakeMsg,'gift_note',{...state.data,side});         bot.sendMessage(chatId,`👤 ${side}\n\nהערה (שלחו \`-\` אם אין)`,{parse_mode:'Markdown'}); }
});

/* ── שמירה לSupabase ── */
async function _saveExpense(msg, expData, silent=false) {
  const chatId = msg.chat.id;
  const exp = { id:uid(), name:expData.name, cat:expData.cat, amount:Number(expData.amount)||0, status:expData.status, note:expData.note||'', receipt:'', date:new Date().toLocaleDateString('he-IL') };
  const { data } = await supabase.from('expenses').insert(exp).select().single();
  clearState(msg);
  if (!silent && data) {
    const {expenses} = await readData();
    const total=expenses.reduce((s,e)=>s+Number(e.amount),0);
    bot.sendMessage(chatId,
      `✅ *ההוצאה נשמרה!*\n\n📝 *${exp.name}*\n${CAT_EMOJI[exp.cat]||'📦'} ${exp.cat}\n💰 ${fmt(exp.amount)}\n📌 ${exp.status}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n💸 סה"כ: *${fmt(total)}*\n\n📸 _שלחו תמונה לצירוף קבלה!_`,
      {parse_mode:'Markdown'}
    );
    setTimeout(()=>mainMenu(chatId),800);
  }
  return data?.id;
}

async function _saveGift(msg, giftData, silent=false) {
  const chatId = msg.chat.id;
  const gift = { id:uid(), name:giftData.name, guests:Number(giftData.guests)||1, amount:Number(giftData.amount)||0, side:giftData.side, note:giftData.note||'' };
  await supabase.from('gifts').insert(gift);
  clearState(msg);
  if (!silent) {
    const {gifts} = await readData();
    const totalGift=gifts.reduce((s,g)=>s+Number(g.amount),0);
    const totalPpl=gifts.reduce((s,g)=>s+Number(g.guests),0);
    const avg=gift.guests>0?(gift.amount/gift.guests).toFixed(0):0;
    bot.sendMessage(chatId,
      `✅ *האורח נשמר!*\n\n👤 *${gift.name}*\n👥 ${gift.guests} אנשים\n💌 ${fmt(gift.amount)} _(ממוצע: ${fmt(avg)})_\n🔖 ${gift.side}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n🎁 סה"כ: *${fmt(totalGift)}* | 👥 *${totalPpl}*`,
      {parse_mode:'Markdown'}
    );
    setTimeout(()=>mainMenu(chatId),800);
  }
}

/* ─────────────────────────────────────────
   הפעלת השרת
───────────────────────────────────────── */
app.listen(PORT, async () => {
  console.log(`✅ שרת פועל על פורט ${PORT}`);
  if (IS_PRODUCTION && WEBHOOK_URL) {
    // Set Telegram webhook
    const webhookEndpoint = `${WEBHOOK_URL}/webhook`;
    await bot.setWebHook(webhookEndpoint);
    console.log(`🔗 Webhook set: ${webhookEndpoint}`);
  } else {
    console.log('🤖 בוט מאזין (polling mode - local development)');
  }
});

bot.on('polling_error', () => {});
process.on('uncaughtException', err => console.error('❌', err.message));
