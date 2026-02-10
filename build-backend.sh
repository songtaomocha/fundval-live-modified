#!/bin/bash

# FundVal Live - Backend Build Script
# Builds the Python backend into a standalone executable using PyInstaller
# Used by: GitHub Actions CI/CD and local development

echo "📦 Building backend with PyInstaller..."

# 安装 PyInstaller
uv pip install pyinstaller

# 打包
uv run pyinstaller backend.spec --clean

# 检查是否成功
if [ -d "dist/fundval-backend" ]; then
    echo "✅ Backend built successfully!"
    echo "📂 Output: dist/fundval-backend/"

    # 测试运行
    echo "🧪 Testing backend..."
    cd dist/fundval-backend
    ./fundval-backend &
    BACKEND_PID=$!
    sleep 3

    # 检查是否启动
    if curl -s http://localhost:21345/api/health > /dev/null; then
        echo "✅ Backend is running!"
        kill $BACKEND_PID
    else
        echo "❌ Backend failed to start"
        kill $BACKEND_PID 2>/dev/null
        exit 1
    fi
else
    echo "❌ Build failed"
    exit 1
fi
