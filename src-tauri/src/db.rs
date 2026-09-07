//! 数据库控制台（第一步）：MySQL / PostgreSQL / Redis 直连，SQL 控制台 + 库表树 + Redis key 浏览。
//!
//! 取值一律按「文本」走：MySQL 用 mysql_async 的 Value 转字符串，PostgreSQL 用简单查询协议
//! （服务器直接回文本），Redis 的值转成 JSON。控制台要的是「看得见」，不是类型安全的 ORM。
//!
//! 密码跟 SSH 一样：不落盘，认证成功后按用户意愿存进系统钥匙串（creds.rs），按连接 id 取。
//! 只对内网开放的库先在那台服务器的隧道页开一条本地转发，这儿填 127.0.0.1 —— 自动开隧道留到下一步。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::ssh::SshError;

/// 连上一个库最多等多久
const CONNECT_LIMIT: Duration = Duration::from_secs(15);
/// 一条查询最多跑多久
const QUERY_LIMIT: Duration = Duration::from_secs(120);
/// 结果集默认最多取多少行
const DEFAULT_LIMIT: u32 = 500;
const MAX_LIMIT: u32 = 5000;

enum Client {
    MySql(mysql_async::Conn),
    Pg(tokio_postgres::Client, tauri::async_runtime::JoinHandle<()>),
    Redis(redis::aio::MultiplexedConnection),
}

struct Db {
    kind: String,
    client: Mutex<Client>,
}

#[derive(Default)]
pub struct DbState {
    dbs: Mutex<HashMap<String, Arc<Db>>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSpec {
    pub session_id: String,
    /// 连接配置 id：钥匙串按它存取密码
    pub conn_id: String,
    /// "mysql" | "postgres" | "redis"
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 不落盘；留空则用钥匙串里存过的
    pub password: Option<String>,
    /// MySQL / PG 的库名；Redis 是 db 编号
    pub database: Option<String>,
    #[serde(default)]
    pub remember: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbOpened {
    pub session_id: String,
    /// 服务器版本，给人看
    pub server: String,
    pub database: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbResult {
    pub columns: Vec<String>,
    /// 每格都是文本；NULL 是 None
    pub rows: Vec<Vec<Option<String>>>,
    /// 写操作影响的行数（查询没有）
    pub affected: Option<u64>,
    /// 到上限就停了，后面还有
    pub truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNode {
    pub name: String,
    /// "table" | "view"
    pub kind: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNode {
    pub name: String,
    pub current: bool,
    pub tables: Vec<TableNode>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSchema {
    pub schemas: Vec<SchemaNode>,
}

async fn db_of(state: &DbState, session_id: &str) -> Result<Arc<Db>, SshError> {
    state
        .dbs
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| SshError::plain("这条数据库连接已经断了，重新连一下"))
}

/// mysql 的值 → 文本
fn mysql_text(value: mysql_async::Value) -> Option<String> {
    use mysql_async::Value::*;
    Some(match value {
        NULL => return None,
        Bytes(bytes) => match String::from_utf8(bytes) {
            Ok(text) => text,
            // 二进制列（BLOB、二进制 UUID）按十六进制给，别吐一屏乱码
            Err(e) => format!("0x{}", hex(e.as_bytes())),
        },
        Int(n) => n.to_string(),
        UInt(n) => n.to_string(),
        Float(f) => f.to_string(),
        Double(f) => f.to_string(),
        Date(y, m, d, h, i, s, us) => {
            // DATE / DATETIME / TIMESTAMP 到这儿是同一个变体，时间部分全零就只显示日期
            if h == 0 && i == 0 && s == 0 && us == 0 {
                format!("{y:04}-{m:02}-{d:02}")
            } else if us == 0 {
                format!("{y:04}-{m:02}-{d:02} {h:02}:{i:02}:{s:02}")
            } else {
                format!("{y:04}-{m:02}-{d:02} {h:02}:{i:02}:{s:02}.{us:06}")
            }
        }
        Time(neg, days, h, i, s, us) => {
            let hours = days * 24 + h as u32;
            let sign = if neg { "-" } else { "" };
            if us == 0 { format!("{sign}{hours:02}:{i:02}:{s:02}") } else { format!("{sign}{hours:02}:{i:02}:{s:02}.{us:06}") }
        }
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn limit_of(limit: Option<u32>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize
}

async fn run_mysql(conn: &mut mysql_async::Conn, sql: &str, limit: usize) -> Result<DbResult, SshError> {
    use mysql_async::prelude::Queryable;
    let started = Instant::now();
    let mut result = conn.query_iter(sql).await.map_err(|e| SshError::new("查询出错", e))?;
    let columns: Vec<String> = result
        .columns()
        .map(|cols| cols.iter().map(|c| c.name_str().into_owned()).collect())
        .unwrap_or_default();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut truncated = false;
    if !columns.is_empty() {
        while let Some(row) = result.next().await.map_err(|e| SshError::new("读结果出错", e))? {
            if rows.len() >= limit {
                truncated = true;
                // 后面的行不要了，但得读完，不然连接就卡在这个结果集上
                continue;
            }
            rows.push(row.unwrap().into_iter().map(mysql_text).collect());
        }
    }
    let affected = if columns.is_empty() { Some(result.affected_rows()) } else { None };
    // 多条语句一起发时后面还有结果集，一并丢掉；只展示第一个
    result.drop_result().await.map_err(|e| SshError::new("清理结果集出错", e))?;
    Ok(DbResult { columns, rows, affected, truncated, elapsed_ms: started.elapsed().as_millis() as u64 })
}

async fn run_pg(client: &tokio_postgres::Client, sql: &str, limit: usize) -> Result<DbResult, SshError> {
    use tokio_postgres::SimpleQueryMessage;
    let started = Instant::now();
    let messages = client.simple_query(sql).await.map_err(|e| SshError::new("查询出错", e))?;
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut truncated = false;
    let mut affected: Option<u64> = None;
    let mut took_first = false;
    for message in messages {
        match message {
            SimpleQueryMessage::Row(row) => {
                if columns.is_empty() && !took_first {
                    columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                }
                // 只展示第一个有行的结果集
                if took_first && columns.len() != row.columns().len() {
                    continue;
                }
                if rows.len() >= limit {
                    truncated = true;
                    continue;
                }
                rows.push((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
            }
            SimpleQueryMessage::CommandComplete(n) => {
                if columns.is_empty() {
                    affected = Some(affected.unwrap_or(0) + n);
                }
                took_first = took_first || !columns.is_empty();
            }
            _ => {}
        }
    }
    let affected = if columns.is_empty() { affected } else { None };
    Ok(DbResult { columns, rows, affected, truncated, elapsed_ms: started.elapsed().as_millis() as u64 })
}

/// 连上一个库
#[tauri::command]
pub async fn db_connect(state: tauri::State<'_, DbState>, spec: DbSpec) -> Result<DbOpened, SshError> {
    if state.dbs.lock().await.contains_key(&spec.session_id) {
        return Err(SshError::plain("这条连接已经开着了"));
    }
    let typed = spec.password.clone().filter(|p| !p.is_empty());
    let secret = typed.clone().or_else(|| crate::creds::load(&spec.conn_id));
    let host = spec.host.trim().to_string();
    if host.is_empty() {
        return Err(SshError::plain("主机还空着"));
    }

    let (client, server, database) = match spec.kind.as_str() {
        "mysql" => {
            let mut opts = mysql_async::OptsBuilder::default()
                .ip_or_hostname(host.clone())
                .tcp_port(spec.port)
                .user(Some(spec.username.clone()))
                .pass(secret.clone());
            if let Some(db) = spec.database.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                opts = opts.db_name(Some(db));
            }
            let conn = tokio::time::timeout(CONNECT_LIMIT, mysql_async::Conn::new(opts))
                .await
                .map_err(|_| SshError::plain("连接超时：主机、端口对不对？只对内网开放的话先在那台服务器的隧道页开一条本地转发"))?
                .map_err(|e| SshError::new("MySQL 连不上", e))?;
            let (major, minor, patch) = conn.server_version();
            let db = spec.database.clone().filter(|d| !d.trim().is_empty());
            (Client::MySql(conn), format!("MySQL {major}.{minor}.{patch}"), db)
        }
        "postgres" => {
            let mut config = tokio_postgres::Config::new();
            config.host(&host).port(spec.port).user(&spec.username).connect_timeout(CONNECT_LIMIT);
            if let Some(pass) = secret.as_deref() {
                config.password(pass);
            }
            let dbname = spec
                .database
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| spec.username.clone());
            config.dbname(&dbname);
            let (client, connection) = tokio::time::timeout(CONNECT_LIMIT, config.connect(tokio_postgres::NoTls))
                .await
                .map_err(|_| SshError::plain("连接超时：主机、端口对不对？只对内网开放的话先在那台服务器的隧道页开一条本地转发"))?
                .map_err(|e| SshError::new("PostgreSQL 连不上", e))?;
            // 连接本身是个要一直跑的任务；断开时 abort 它
            let task = tauri::async_runtime::spawn(async move {
                let _ = connection.await;
            });
            let version = client
                .query_one("select version()", &[])
                .await
                .ok()
                .and_then(|row| row.try_get::<_, String>(0).ok())
                .map(|v| v.split(" on ").next().unwrap_or(&v).to_string())
                .unwrap_or_else(|| "PostgreSQL".into());
            (Client::Pg(client, task), version, Some(dbname))
        }
        "redis" => {
            let db_index = spec.database.as_deref().map(str::trim).filter(|d| !d.is_empty()).and_then(|d| d.parse::<i64>().ok()).unwrap_or(0);
            let info = redis::ConnectionInfo {
                addr: redis::ConnectionAddr::Tcp(host.clone(), spec.port),
                redis: redis::RedisConnectionInfo {
                    db: db_index,
                    username: Some(spec.username.trim().to_string()).filter(|u| !u.is_empty()),
                    password: secret.clone(),
                    protocol: redis::ProtocolVersion::RESP2,
                },
            };
            let client = redis::Client::open(info).map_err(|e| SshError::new("Redis 地址不对", e))?;
            let mut conn = tokio::time::timeout(CONNECT_LIMIT, client.get_multiplexed_tokio_connection())
                .await
                .map_err(|_| SshError::plain("连接超时：主机、端口对不对？只对内网开放的话先在那台服务器的隧道页开一条本地转发"))?
                .map_err(|e| SshError::new("Redis 连不上", e))?;
            // 先 PING 一下：密码不对在这一步才会暴露
            let pong: String = redis::cmd("PING")
                .query_async(&mut conn)
                .await
                .map_err(|e| SshError::new("Redis 不认这个连接（密码不对？）", e))?;
            let _ = pong;
            let version = redis::cmd("INFO")
                .arg("server")
                .query_async::<String>(&mut conn)
                .await
                .ok()
                .and_then(|text| text.lines().find_map(|l| l.strip_prefix("redis_version:").map(|v| v.trim().to_string())))
                .map(|v| format!("Redis {v}"))
                .unwrap_or_else(|| "Redis".into());
            (Client::Redis(conn), version, Some(db_index.to_string()))
        }
        other => return Err(SshError::plain(&format!("不认识的数据库类型：{other}"))),
    };

    // 认证过了才存，跟 SSH 一个规矩
    if spec.remember {
        if let Some(pass) = typed.as_deref() {
            crate::creds::save(&spec.conn_id, pass);
        }
    }

    state
        .dbs
        .lock()
        .await
        .insert(spec.session_id.clone(), Arc::new(Db { kind: spec.kind.clone(), client: Mutex::new(client) }));
    Ok(DbOpened { session_id: spec.session_id, server, database })
}

#[tauri::command]
pub async fn db_close(state: tauri::State<'_, DbState>, session_id: String) -> Result<(), SshError> {
    let Some(db) = state.dbs.lock().await.remove(&session_id) else {
        return Ok(());
    };
    // 别人还握着 Arc（一条查询正在跑）就等它完
    let mut client = db.client.lock().await;
    match &mut *client {
        Client::MySql(_) => {
            // disconnect 要拿走所有权，这儿拿不到；drop 时 mysql_async 会自己收
        }
        Client::Pg(_, task) => task.abort(),
        Client::Redis(_) => {}
    }
    Ok(())
}

/// 跑一条 SQL。结果最多 limit 行（默认 500，上限 5000）
#[tauri::command]
pub async fn db_query(
    state: tauri::State<'_, DbState>,
    session_id: String,
    sql: String,
    limit: Option<u32>,
) -> Result<DbResult, SshError> {
    let db = db_of(&state, &session_id).await?;
    let sql = sql.trim();
    if sql.is_empty() {
        return Err(SshError::plain("SQL 是空的"));
    }
    let limit = limit_of(limit);
    let mut client = db.client.lock().await;
    let work = async {
        match &mut *client {
            Client::MySql(conn) => run_mysql(conn, sql, limit).await,
            Client::Pg(pg, _) => run_pg(pg, sql, limit).await,
            Client::Redis(_) => Err(SshError::plain("Redis 连接不跑 SQL，用命令行那一栏")),
        }
    };
    tokio::time::timeout(QUERY_LIMIT, work)
        .await
        .map_err(|_| SshError::plain("这条查询跑太久，放弃了（超过 120 秒）"))?
}

/// 库 → 表 的树。MySQL 列所有库（系统库除外），PG 列当前库的所有 schema
#[tauri::command]
pub async fn db_schema(state: tauri::State<'_, DbState>, session_id: String) -> Result<DbSchema, SshError> {
    let db = db_of(&state, &session_id).await?;
    let mut client = db.client.lock().await;
    let (list_sql, current_sql) = match db.kind.as_str() {
        "mysql" => (
            "SELECT table_schema, table_name, table_type FROM information_schema.tables \
             WHERE table_schema NOT IN ('information_schema','performance_schema','mysql','sys') \
             ORDER BY table_schema, table_name",
            "SELECT DATABASE()",
        ),
        "postgres" => (
            "SELECT table_schema, table_name, table_type FROM information_schema.tables \
             WHERE table_schema NOT IN ('pg_catalog','information_schema') \
             ORDER BY table_schema, table_name",
            "SELECT current_schema()",
        ),
        _ => return Err(SshError::plain("Redis 没有库表树")),
    };
    let (listing, current) = match &mut *client {
        Client::MySql(conn) => {
            let listing = run_mysql(conn, list_sql, MAX_LIMIT as usize).await?;
            // 空库在 information_schema.tables 里没有行，单独补一遍
            let dbs = run_mysql(conn, "SHOW DATABASES", MAX_LIMIT as usize).await?;
            let current = run_mysql(conn, current_sql, 1).await?;
            let mut names: Vec<String> = dbs.rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect();
            names.retain(|n| !matches!(n.as_str(), "information_schema" | "performance_schema" | "mysql" | "sys"));
            let mut schema = build_schema(listing, current.rows.first().and_then(|r| r.first().cloned().flatten()));
            for name in names {
                if !schema.schemas.iter().any(|s| s.name == name) {
                    schema.schemas.push(SchemaNode { name, current: false, tables: Vec::new() });
                }
            }
            schema.schemas.sort_by(|a, b| a.name.cmp(&b.name));
            return Ok(schema);
        }
        Client::Pg(pg, _) => {
            let listing = run_pg(pg, list_sql, MAX_LIMIT as usize).await?;
            let current = run_pg(pg, current_sql, 1).await?;
            (listing, current.rows.first().and_then(|r| r.first().cloned().flatten()))
        }
        Client::Redis(_) => unreachable!(),
    };
    Ok(build_schema(listing, current))
}

fn build_schema(listing: DbResult, current: Option<String>) -> DbSchema {
    let mut schemas: Vec<SchemaNode> = Vec::new();
    for row in listing.rows {
        let mut it = row.into_iter();
        let (Some(Some(schema)), Some(Some(table)), kind) = (it.next(), it.next(), it.next().flatten()) else { continue };
        let kind = if kind.as_deref().map(|k| k.to_ascii_uppercase().contains("VIEW")).unwrap_or(false) { "view" } else { "table" };
        let node = match schemas.iter_mut().find(|s| s.name == schema) {
            Some(node) => node,
            None => {
                schemas.push(SchemaNode { current: current.as_deref() == Some(schema.as_str()), name: schema, tables: Vec::new() });
                schemas.last_mut().unwrap()
            }
        };
        node.tables.push(TableNode { name: table, kind: kind.into() });
    }
    DbSchema { schemas }
}

// ---------- Redis ----------

/// redis 的值 → JSON，给前端直接画
fn redis_json(value: redis::Value) -> serde_json::Value {
    use redis::Value::*;
    use serde_json::Value as J;
    match value {
        Nil => J::Null,
        Int(n) => J::from(n),
        BulkString(bytes) => match String::from_utf8(bytes) {
            Ok(text) => J::String(text),
            Err(e) => J::String(format!("0x{}", hex(e.as_bytes()))),
        },
        SimpleString(text) => J::String(text),
        Okay => J::String("OK".into()),
        Array(items) | Set(items) => J::Array(items.into_iter().map(redis_json).collect()),
        Map(pairs) => J::Array(
            pairs
                .into_iter()
                .flat_map(|(k, v)| [redis_json(k), redis_json(v)])
                .collect(),
        ),
        Double(f) => serde_json::Number::from_f64(f).map(J::Number).unwrap_or(J::Null),
        Boolean(b) => J::Bool(b),
        VerbatimString { text, .. } => J::String(text),
        BigNumber(n) => J::String(n.to_string()),
        other => J::String(format!("{other:?}")),
    }
}

async fn redis_of(state: &DbState, session_id: &str) -> Result<Arc<Db>, SshError> {
    let db = db_of(state, session_id).await?;
    if db.kind != "redis" {
        return Err(SshError::plain("这不是 Redis 连接"));
    }
    Ok(db)
}

/// 原样跑一条 Redis 命令（参数已经切好）
#[tauri::command]
pub async fn redis_command(
    state: tauri::State<'_, DbState>,
    session_id: String,
    args: Vec<String>,
) -> Result<serde_json::Value, SshError> {
    let db = redis_of(&state, &session_id).await?;
    let Some((name, rest)) = args.split_first() else {
        return Err(SshError::plain("命令是空的"));
    };
    let mut client = db.client.lock().await;
    let Client::Redis(conn) = &mut *client else { unreachable!() };
    let mut cmd = redis::cmd(name);
    for arg in rest {
        cmd.arg(arg);
    }
    let started = Instant::now();
    let value: redis::Value = tokio::time::timeout(QUERY_LIMIT, cmd.query_async(conn))
        .await
        .map_err(|_| SshError::plain("这条命令跑太久，放弃了"))?
        .map_err(|e| SshError::new("Redis 报错", e))?;
    let _ = started;
    Ok(redis_json(value))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKey {
    pub key: String,
    /// string / hash / list / set / zset / stream …
    pub kind: String,
    /// -1 = 不过期，-2 = 不存在
    pub ttl: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisScan {
    pub cursor: u64,
    pub keys: Vec<RedisKey>,
}

/// SCAN 一页 key，顺便把类型和 TTL 一起带回来
#[tauri::command]
pub async fn redis_scan(
    state: tauri::State<'_, DbState>,
    session_id: String,
    pattern: String,
    cursor: u64,
    count: Option<u32>,
) -> Result<RedisScan, SshError> {
    let db = redis_of(&state, &session_id).await?;
    let mut client = db.client.lock().await;
    let Client::Redis(conn) = &mut *client else { unreachable!() };
    let pattern = if pattern.trim().is_empty() { "*".to_string() } else { pattern.trim().to_string() };
    let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(&pattern)
        .arg("COUNT")
        .arg(count.unwrap_or(200).clamp(10, 1000))
        .query_async(conn)
        .await
        .map_err(|e| SshError::new("SCAN 出错", e))?;
    if keys.is_empty() {
        return Ok(RedisScan { cursor: next, keys: Vec::new() });
    }
    let mut pipe = redis::pipe();
    for key in &keys {
        pipe.cmd("TYPE").arg(key).cmd("TTL").arg(key);
    }
    let flat: Vec<redis::Value> = pipe.query_async(conn).await.map_err(|e| SshError::new("读 key 类型出错", e))?;
    let mut out = Vec::with_capacity(keys.len());
    for (i, key) in keys.into_iter().enumerate() {
        let kind = match flat.get(i * 2) {
            Some(redis::Value::SimpleString(s)) => s.clone(),
            Some(redis::Value::BulkString(b)) => String::from_utf8_lossy(b).into_owned(),
            _ => "?".into(),
        };
        let ttl = match flat.get(i * 2 + 1) {
            Some(redis::Value::Int(n)) => *n,
            _ => -1,
        };
        out.push(RedisKey { key, kind, ttl });
    }
    Ok(RedisScan { cursor: next, keys: out })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisPeek {
    pub kind: String,
    pub ttl: i64,
    /// 总长度（hash 的字段数、list 的元素数……）；string 是字节数
    pub len: u64,
    /// 内容；大的只取前面一部分
    pub value: serde_json::Value,
    pub truncated: bool,
}

const PEEK_LIMIT: usize = 200;

/// 看一个 key 的内容，按类型取；大集合只取前 200 项
#[tauri::command]
pub async fn redis_peek(state: tauri::State<'_, DbState>, session_id: String, key: String) -> Result<RedisPeek, SshError> {
    let db = redis_of(&state, &session_id).await?;
    let mut client = db.client.lock().await;
    let Client::Redis(conn) = &mut *client else { unreachable!() };
    let kind: String = redis::cmd("TYPE").arg(&key).query_async(conn).await.map_err(|e| SshError::new("读不到这个 key", e))?;
    let ttl: i64 = redis::cmd("TTL").arg(&key).query_async(conn).await.unwrap_or(-1);
    let (len, value, truncated): (u64, redis::Value, bool) = match kind.as_str() {
        "string" => {
            let len: u64 = redis::cmd("STRLEN").arg(&key).query_async(conn).await.unwrap_or(0);
            let value: redis::Value = redis::cmd("GETRANGE").arg(&key).arg(0).arg(64 * 1024).query_async(conn).await.map_err(|e| SshError::new("GET 出错", e))?;
            (len, value, len > 64 * 1024 + 1)
        }
        "hash" => {
            let len: u64 = redis::cmd("HLEN").arg(&key).query_async(conn).await.unwrap_or(0);
            let (_, items): (u64, redis::Value) = redis::cmd("HSCAN").arg(&key).arg(0).arg("COUNT").arg(PEEK_LIMIT).query_async(conn).await.map_err(|e| SshError::new("HSCAN 出错", e))?;
            (len, items, len as usize > PEEK_LIMIT)
        }
        "list" => {
            let len: u64 = redis::cmd("LLEN").arg(&key).query_async(conn).await.unwrap_or(0);
            let items: redis::Value = redis::cmd("LRANGE").arg(&key).arg(0).arg(PEEK_LIMIT as i64 - 1).query_async(conn).await.map_err(|e| SshError::new("LRANGE 出错", e))?;
            (len, items, len as usize > PEEK_LIMIT)
        }
        "set" => {
            let len: u64 = redis::cmd("SCARD").arg(&key).query_async(conn).await.unwrap_or(0);
            let (_, items): (u64, redis::Value) = redis::cmd("SSCAN").arg(&key).arg(0).arg("COUNT").arg(PEEK_LIMIT).query_async(conn).await.map_err(|e| SshError::new("SSCAN 出错", e))?;
            (len, items, len as usize > PEEK_LIMIT)
        }
        "zset" => {
            let len: u64 = redis::cmd("ZCARD").arg(&key).query_async(conn).await.unwrap_or(0);
            let items: redis::Value = redis::cmd("ZRANGE").arg(&key).arg(0).arg(PEEK_LIMIT as i64 - 1).arg("WITHSCORES").query_async(conn).await.map_err(|e| SshError::new("ZRANGE 出错", e))?;
            (len, items, len as usize > PEEK_LIMIT)
        }
        "stream" => {
            let len: u64 = redis::cmd("XLEN").arg(&key).query_async(conn).await.unwrap_or(0);
            let items: redis::Value = redis::cmd("XRANGE").arg(&key).arg("-").arg("+").arg("COUNT").arg(50).query_async(conn).await.map_err(|e| SshError::new("XRANGE 出错", e))?;
            (len, items, len > 50)
        }
        "none" => return Err(SshError::plain("这个 key 不存在了")),
        _ => (0, redis::Value::Nil, false),
    };
    Ok(RedisPeek { kind, ttl, len, value: redis_json(value), truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_values_render_as_text() {
        use mysql_async::Value;
        assert_eq!(mysql_text(Value::NULL), None);
        assert_eq!(mysql_text(Value::Int(-3)).as_deref(), Some("-3"));
        assert_eq!(mysql_text(Value::Bytes(b"abc".to_vec())).as_deref(), Some("abc"));
        assert_eq!(mysql_text(Value::Bytes(vec![0xff, 0x00])).as_deref(), Some("0xff00"));
        assert_eq!(mysql_text(Value::Date(2026, 9, 7, 0, 0, 0, 0)).as_deref(), Some("2026-09-07"));
        assert_eq!(mysql_text(Value::Date(2026, 9, 7, 21, 5, 9, 0)).as_deref(), Some("2026-09-07 21:05:09"));
        assert_eq!(mysql_text(Value::Time(true, 1, 2, 3, 4, 0)).as_deref(), Some("-26:03:04"));
    }

    #[test]
    fn schema_tree_groups_tables_by_schema() {
        let listing = DbResult {
            columns: vec![],
            rows: vec![
                vec![Some("app".into()), Some("users".into()), Some("BASE TABLE".into())],
                vec![Some("app".into()), Some("v_active".into()), Some("VIEW".into())],
                vec![Some("logs".into()), Some("events".into()), Some("BASE TABLE".into())],
            ],
            affected: None,
            truncated: false,
            elapsed_ms: 0,
        };
        let schema = build_schema(listing, Some("app".into()));
        assert_eq!(schema.schemas.len(), 2);
        assert!(schema.schemas[0].current);
        assert_eq!(schema.schemas[0].tables[1].kind, "view");
        assert!(!schema.schemas[1].current);
    }

    #[test]
    fn redis_values_become_json() {
        use redis::Value;
        assert_eq!(redis_json(Value::Nil), serde_json::Value::Null);
        assert_eq!(redis_json(Value::Int(7)), serde_json::json!(7));
        assert_eq!(redis_json(Value::BulkString(b"hi".to_vec())), serde_json::json!("hi"));
        assert_eq!(redis_json(Value::Okay), serde_json::json!("OK"));
        assert_eq!(
            redis_json(Value::Array(vec![Value::Int(1), Value::BulkString(b"x".to_vec())])),
            serde_json::json!([1, "x"])
        );
    }
}
