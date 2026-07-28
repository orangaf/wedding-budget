@echo off
title Wedding Budget Tracker
echo =========================================
echo 💍 מאזן החתונה - מפעיל את השרת...
echo =========================================
echo.

cd /d "C:\Users\orang\.gemini\antigravity\scratch\wedding-budget"

:: Start the website in the default browser
start http://localhost:3001/index.html

:: Start the Node.js server (this will keep the command prompt open)
node server.js

pause
