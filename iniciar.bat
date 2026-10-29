@echo off
title Administracion de Consorcios
rem pushd mapea rutas de red (UNC) a una letra de unidad temporal; cd /d no puede.
pushd "%~dp0" || (echo No se pudo acceder a la carpeta de la app: %~dp0 & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\server.ps1" %*
popd
pause
