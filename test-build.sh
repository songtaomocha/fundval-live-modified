#!/bin/bash

# FundVal Live - Build Test Script
# Tests the complete build process: frontend + backend + Electron packaging
# Run this before pushing to verify the build works locally

set -e

echo "🧪 Testing Electron build process..."

# 1. 检查依赖
echo "📦 Checking dependencies..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found"
    exit 1
fi

if ! command -v uv &> /dev/null; then
    echo "❌ uv not found"
    exit 1
fi

echo "✅ Dependencies OK"

# 2. 安装 npm 依赖
echo "📦 Installing npm dependencies..."
npm install

# 3. 构建前端
echo "🏗️  Building frontend..."
cd frontend
npm install
npm run build
cd ..

if [ ! -d "frontend/dist" ]; then
    echo "❌ Frontend build failed"
    exit 1
fi
echo "✅ Frontend built"

# 4. 构建后端
echo "🏗️  Building backend..."
# 使用 uv 安装 PyInstaller
uv pip install pyinstaller

# 使用 uv run 执行 pyinstaller
uv run pyinstaller backend.spec --clean

if [ ! -d "dist/fundval-backend" ]; then
    echo "❌ Backend build failed"
    exit 1
fi
echo "✅ Backend built"

# 5. 测试打包（不生成安装包，只生成目录）
echo "📦 Testing Electron packaging..."
npm run pack

if [ -d "release/mac" ] || [ -d "release/mac-arm64" ] || [ -d "release/win-unpacked" ] || [ -d "release/linux-unpacked" ]; then
    echo "✅ Electron packaging test passed"
    echo "📂 Output:"
    ls -la release/
else
    echo "❌ Electron packaging test failed"
    exit 1
fi

echo ""
echo "✅ All tests passed!"
echo ""
echo "Next steps:"
echo "1. Run 'npm run dist' to create installers"
echo "2. Or push a tag to trigger GitHub Actions"
