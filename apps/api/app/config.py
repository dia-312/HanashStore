from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://sales:sales@127.0.0.1:5432/sales"
    # Must be true in production (HTTPS only). Local plain-HTTP development sets it to false.
    cookie_secure: bool = True
    session_days: int = 30
    # argon2id cost. Defaults are argon2-cffi's; tests lower them to stay fast.
    argon2_time_cost: int = 3
    argon2_memory_kib: int = 65536


@lru_cache
def get_settings() -> Settings:
    return Settings()
