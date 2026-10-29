@echo off
title Administracion de Consorcios
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" %*
pause
