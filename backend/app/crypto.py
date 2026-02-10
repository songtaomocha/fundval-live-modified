import os
import sys
from pathlib import Path
from cryptography.fernet import Fernet

def _get_key_file_path():
    """动态获取密钥文件路径，避免循环依赖"""
    if getattr(sys, 'frozen', False):
        base_dir = Path.home() / '.fundval-live'
    else:
        base_dir = Path(__file__).resolve().parent.parent

    return base_dir / "data" / ".encryption_key"

def _get_or_create_key():
    """获取或创建加密密钥"""
    key_file = _get_key_file_path()

    if key_file.exists():
        with open(key_file, "rb") as f:
            return f.read()
    else:
        key = Fernet.generate_key()
        key_file.parent.mkdir(parents=True, exist_ok=True)
        with open(key_file, "wb") as f:
            f.write(key)
        os.chmod(key_file, 0o600)
        return key

def encrypt_value(plaintext: str) -> str:
    """加密字符串"""
    if not plaintext:
        return ""
    try:
        key = _get_or_create_key()
        f = Fernet(key)
        encrypted = f.encrypt(plaintext.encode())
        return encrypted.decode()
    except Exception as e:
        print(f"Encryption error: {e}")
        return ""

def decrypt_value(ciphertext: str) -> str:
    """解密字符串"""
    if not ciphertext:
        return ""
    try:
        key = _get_or_create_key()
        f = Fernet(key)
        decrypted = f.decrypt(ciphertext.encode())
        return decrypted.decode()
    except Exception as e:
        print(f"Decryption error: {e}")
        return ""
