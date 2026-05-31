@echo off
title CRC Green Lab
echo.
echo  Iniciando CRC Green Lab...
echo.

if not exist node_modules (
  echo  Instalando dependencias (primeira vez, aguarde)...
  npm install
  echo.
)

node server.js
pause
