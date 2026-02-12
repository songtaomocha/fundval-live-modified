"""
认证和授权工具函数
"""
import bcrypt
import secrets
import sqlite3
from typing import Optional
from datetime import datetime, timedelta
from dataclasses import dataclass
from fastapi import Request, HTTPException, status
from .db import get_db_connection


# Session 配置
SESSION_COOKIE_NAME = "session_id"
SESSION_EXPIRY_DAYS = 30
# 仅在会话临近过期时才续期，避免每次请求都写库导致锁竞争
SESSION_REFRESH_THRESHOLD_HOURS = 12


@dataclass
class User:
    """用户模型"""
    id: int
    username: str
    is_admin: bool


def hash_password(password: str) -> str:
    """
    哈希密码

    Args:
        password: 明文密码

    Returns:
        str: bcrypt 哈希值
    """
    # bcrypt 自动生成 salt 并包含在哈希值中
    password_bytes = password.encode('utf-8')
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password_bytes, salt)
    return hashed.decode('utf-8')


def verify_password(password: str, password_hash: str) -> bool:
    """
    验证密码

    Args:
        password: 明文密码
        password_hash: bcrypt 哈希值

    Returns:
        bool: 密码是否匹配
    """
    try:
        password_bytes = password.encode('utf-8')
        hash_bytes = password_hash.encode('utf-8')
        return bcrypt.checkpw(password_bytes, hash_bytes)
    except Exception:
        return False


def _get_setting_bool(key: str, default: bool = False) -> bool:
    """
    从 settings 表读取布尔值配置

    Args:
        key: 配置键
        default: 默认值

    Returns:
        bool: 配置值
    """
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = ? AND user_id IS NULL", (key,))
        row = cursor.fetchone()
        if row is None:
            return default
        return row[0] == '1'
    finally:
        conn.close()


def is_multi_user_mode() -> bool:
    """
    获取多用户模式状态

    Returns:
        bool: True 表示多用户模式，False 表示单用户模式
    """
    return _get_setting_bool('multi_user_mode', False)


def is_registration_allowed() -> bool:
    """
    获取注册开关状态

    Returns:
        bool: True 表示允许注册，False 表示禁止注册
    """
    return _get_setting_bool('allow_registration', False)


# ============================================================================
# Session 管理（SQLite 持久化，避免容器重启后会话丢失）
# ============================================================================

def _ensure_session_table(conn):
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS user_sessions (
            session_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expiry TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expiry)")


def create_session(user_id: int) -> str:
    """创建 session 并持久化到 SQLite"""
    session_id = secrets.token_urlsafe(32)
    expiry = datetime.now() + timedelta(days=SESSION_EXPIRY_DAYS)

    conn = get_db_connection()
    try:
        _ensure_session_table(conn)
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO user_sessions (session_id, user_id, expiry, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (session_id, user_id, expiry.isoformat())
        )
        conn.commit()
    finally:
        conn.close()

    return session_id


def get_session_user(session_id: str) -> Optional[int]:
    """获取 session 对应 user_id，过期自动清理并续期"""
    conn = get_db_connection()
    try:
        _ensure_session_table(conn)
        cursor = conn.cursor()
        cursor.execute("SELECT user_id, expiry FROM user_sessions WHERE session_id = ?", (session_id,))
        row = cursor.fetchone()
        if row is None:
            return None

        try:
            expiry = datetime.fromisoformat(row[1])
        except Exception:
            cursor.execute("DELETE FROM user_sessions WHERE session_id = ?", (session_id,))
            conn.commit()
            return None

        if datetime.now() > expiry:
            cursor.execute("DELETE FROM user_sessions WHERE session_id = ?", (session_id,))
            conn.commit()
            return None

        # 续期：仅在临近过期时才续期，减少高频写入
        now = datetime.now()
        refresh_threshold = timedelta(hours=SESSION_REFRESH_THRESHOLD_HOURS)
        if (expiry - now) <= refresh_threshold:
            new_expiry = (now + timedelta(days=SESSION_EXPIRY_DAYS)).isoformat()
            try:
                cursor.execute(
                    "UPDATE user_sessions SET expiry = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?",
                    (new_expiry, session_id)
                )
                conn.commit()
            except sqlite3.OperationalError:
                # 遇到瞬时锁冲突时不阻塞请求，保持当前会话继续可用
                pass

        return int(row[0])
    finally:
        conn.close()


def cleanup_expired_sessions():
    """清理过期 session"""
    conn = get_db_connection()
    try:
        _ensure_session_table(conn)
        cursor = conn.cursor()
        now_iso = datetime.now().isoformat()
        cursor.execute("DELETE FROM user_sessions WHERE expiry < ?", (now_iso,))
        deleted = cursor.rowcount if cursor.rowcount is not None else 0
        conn.commit()
        return deleted
    finally:
        conn.close()


def delete_session(session_id: str):
    """删除 session"""
    conn = get_db_connection()
    try:
        _ensure_session_table(conn)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM user_sessions WHERE session_id = ?", (session_id,))
        conn.commit()
    finally:
        conn.close()


def _get_user_by_id(user_id: int) -> Optional[User]:
    """
    根据 user_id 获取用户信息

    Args:
        user_id: 用户 ID

    Returns:
        Optional[User]: 用户对象，如果不存在则返回 None
    """
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, is_admin FROM users WHERE id = ?",
            (user_id,)
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return User(id=row[0], username=row[1], is_admin=row[2])
    finally:
        conn.close()


# ============================================================================
# FastAPI Dependencies
# ============================================================================

def get_current_user(request: Request) -> Optional[User]:
    """
    获取当前用户（FastAPI Dependency）

    Args:
        request: FastAPI Request 对象

    Returns:
        Optional[User]: 用户对象
            - 单用户模式：返回 None
            - 多用户模式：从 cookie 读取 session_id，返回 User 对象
    """
    # 单用户模式：不需要认证
    if not is_multi_user_mode():
        return None

    # 多用户模式：从 cookie 读取 session_id
    session_id = request.cookies.get(SESSION_COOKIE_NAME)
    if not session_id:
        return None

    # 获取 user_id
    user_id = get_session_user(session_id)
    if not user_id:
        return None

    # 获取用户信息
    return _get_user_by_id(user_id)


def require_auth(request: Request) -> User:
    """
    强制要求登录（FastAPI Dependency）

    Args:
        request: FastAPI Request 对象

    Returns:
        User: 用户对象

    Raises:
        HTTPException: 401 未登录
    """
    user = get_current_user(request)

    # 单用户模式：不需要认证，返回虚拟用户
    if not is_multi_user_mode():
        return User(id=0, username='single_user', is_admin=True)

    # 多用户模式：必须登录
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="未登录"
        )

    return user


def require_admin(request: Request) -> User:
    """
    强制要求管理员权限（FastAPI Dependency）

    Args:
        request: FastAPI Request 对象

    Returns:
        User: 用户对象

    Raises:
        HTTPException: 401 未登录，403 权限不足
    """
    user = require_auth(request)

    # 检查是否为管理员
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="权限不足"
        )

    return user

