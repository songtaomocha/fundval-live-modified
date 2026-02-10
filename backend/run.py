#!/usr/bin/env python3
"""
FundVal Live Backend Entry Point
用于 PyInstaller 打包
"""
import sys
import os
import traceback

# 添加 backend 目录到 Python 路径
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)


def show_error_dialog(title, message):
    """显示错误对话框（跨平台）"""
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()  # 隐藏主窗口
        messagebox.showerror(title, message)
        root.destroy()
    except Exception:
        # 如果 tkinter 不可用，打印到控制台并等待用户按键
        print(f"\n{'='*60}")
        print(f"错误: {title}")
        print(f"{'='*60}")
        print(message)
        print(f"{'='*60}\n")
        input("按回车键退出...")


def parse_error_message(error):
    """解析常见错误，返回用户友好的错误信息"""
    error_str = str(error).lower()

    # 端口冲突
    if "address already in use" in error_str or "port" in error_str:
        port = os.getenv("PORT", "21345")
        return (
            f"端口冲突\n\n"
            f"端口 {port} 已被其他程序占用。\n\n"
            f"解决方法：\n"
            f"1. 关闭占用该端口的程序\n"
            f"2. 或设置环境变量 PORT 使用其他端口\n\n"
            f"原始错误: {error}"
        )

    # 数据库错误
    if "database" in error_str or "sqlite" in error_str:
        return (
            f"数据库错误\n\n"
            f"无法访问或初始化数据库。\n\n"
            f"解决方法：\n"
            f"1. 检查数据库文件是否损坏\n"
            f"2. 尝试删除数据库文件重新初始化\n\n"
            f"原始错误: {error}"
        )

    # 权限错误
    if "permission" in error_str or "access denied" in error_str:
        return (
            f"权限错误\n\n"
            f"程序没有足够的权限访问必要的文件或端口。\n\n"
            f"解决方法：\n"
            f"1. 以管理员身份运行程序\n"
            f"2. 检查文件权限设置\n\n"
            f"原始错误: {error}"
        )

    # 其他错误
    return (
        f"启动失败\n\n"
        f"程序启动时发生错误。\n\n"
        f"错误信息:\n{error}\n\n"
        f"请查看日志文件获取详细信息。"
    )


if __name__ == "__main__":
    try:
        # 使用绝对导入
        import uvicorn
        from app.main import app

        port = int(os.getenv("PORT", "21345"))
        print(f"正在启动 FundVal Live 后端服务...")
        print(f"监听端口: {port}")
        print(f"访问地址: http://localhost:{port}")

        uvicorn.run(
            app,
            host="0.0.0.0",
            port=port,
            log_level="info"
        )

    except Exception as e:
        # 捕获所有启动错误
        error_message = parse_error_message(e)

        # 显示错误对话框
        show_error_dialog("FundVal Live 启动失败", error_message)

        # 打印完整的 traceback 到控制台（用于调试）
        print("\n完整错误信息:")
        traceback.print_exc()

        # 退出
        sys.exit(1)
