#!/bin/bash
if [ ! -f .env ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
fi
echo "Starting services..."
docker-compose up -d --build
echo ""
echo "Service started! Access at http://localhost:36001"
