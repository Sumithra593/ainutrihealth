@echo off
REM run_cv2_diagnostics.bat
REM Usage: double-click or run from CMD (recommended)

cd /d "%~dp0"

echo === Activating venv ===
call venv\Scripts\activate.bat
if errorlevel 1 (
  echo Failed to activate venv. Make sure venv exists.
  pause
  exit /b 1
)

echo === Python executable ===
python -c "import sys; print('exe=', sys.executable)" > where_python.txt 2>&1
type where_python.txt
echo.

echo === pip list ===
python -m pip list > pip_list.txt 2>&1
type pip_list.txt
echo.

echo === Listing cv2 package files ===
dir venv\Lib\site-packages\cv2 /b /s > cv2_files.txt 2>&1
type cv2_files.txt
echo.

echo === Running cv2 import test and saving full traceback to cv2_traceback.txt ===
python -c "import traceback
try:
    import cv2
    print('cv2 OK:', cv2.__version__, cv2.__file__)
except Exception:
    traceback.print_exc()" > cv2_traceback.txt 2>&1

echo === cv2_traceback.txt content ===
type cv2_traceback.txt
echo.

echo Diagnostics complete. Files created:
echo  - where_python.txt
echo  - pip_list.txt
echo  - cv2_files.txt
echo  - cv2_traceback.txt

pause
