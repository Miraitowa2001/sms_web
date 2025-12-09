@echo off
if not exist .env (
    echo Creating .env from .env.example...
    copy .env.example .env
)
echo Starting services...
docker-compose up -d --build
echo.
echo Service started! Access at http://localhost:36001
pause
