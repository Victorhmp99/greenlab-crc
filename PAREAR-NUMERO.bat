@echo off
chcp 65001 >nul
title Parear numero WhatsApp (CRC)
cd /d "%~dp0"
echo.
echo  ═══ PAREAR NUMERO POR CODIGO ═══
echo.
set /p NUM="Numero (com DDI+DDD, ex 5561999998888): "
set /p NOME="Nome do numero (ex Recepcao): "
echo.
node pair-local.mjs %NUM% "%NOME%"
echo.
pause
