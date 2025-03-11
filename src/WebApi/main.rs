use actix_web::{get, post, web, App, HttpResponse, HttpServer, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::collections::HashMap;

// Hardcoded clients mapping (client id -> limite)
static CLIENTS: Lazy<HashMap<i32, i32>> = Lazy::new(|| {
    let mut m = HashMap::new();
    m.insert(1, 100000);
    m.insert(2, 80000);
    m.insert(3, 1000000);
    m.insert(4, 10000000);
    m.insert(5, 500000);
    m
});

#[derive(Serialize)]
struct SaldoDto {
    total: i32,
    limite: i32,
    // using ISO8601 formatted string for the timestamp
    data_extrato: String,
}

#[derive(Serialize, Deserialize)]
struct TransacaoDto {
    valor: i32,
    tipo: String,
    descricao: String,
}

#[derive(Serialize)]
struct ExtratoDto {
    saldo: SaldoDto,
    ultimas_transacoes: Option<Vec<TransacaoDto>>,
}

#[derive(Serialize)]
struct ClienteDto {
    id: i32,
    limite: i32,
    saldo: i32,
}

/// GET /clientes/{id}/extrato
#[get("/clientes/{id}/extrato")]
async fn get_extrato(
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> Result<HttpResponse> {
    let id = path.into_inner();

    // validate that the client exists (using our hardcoded dictionary)
    let limite = match CLIENTS.get(&id) {
        Some(&lim) => lim,
        None => return Ok(HttpResponse::NotFound().finish()),
    };

    // Execute the stored procedure GetSaldoClienteById
    // Expected columns: total, limite, data_extrato, ultimas_transacoes (JSON)
    let row = sqlx::query!(
        r#"
        SELECT total, limite, data_extrato, ultimas_transacoes
        FROM GetSaldoClienteById($1)
        "#,
        id
    )
    .fetch_one(pool.get_ref())
    .await
    .map_err(|_| HttpResponse::NotFound().finish())?;

    let saldo = SaldoDto {
        total: row.total,
        limite: row.limite,
        data_extrato: row.data_extrato.to_rfc3339(),
    };

    // Parse the JSON field holding the list of transactions.
    let ultimas_transacoes: Option<Vec<TransacaoDto>> = match row.ultimas_transacoes {
        Some(json_value) => serde_json::from_value(json_value).ok(),
        None => None,
    };

    let extrato = ExtratoDto {
        saldo,
        ultimas_transacoes,
    };

    Ok(HttpResponse::Ok().json(extrato))
}

/// Checks if the transaction is valid.
fn is_transacao_valid(transacao: &TransacaoDto) -> bool {
    let tipo = transacao.tipo.as_str();
    (tipo == "c" || tipo == "d")
        && !transacao.descricao.is_empty()
        && transacao.descricao.len() <= 10
        && transacao.valor > 0
}

/// POST /clientes/{id}/transacoes
#[post("/clientes/{id}/transacoes")]
async fn post_transacao(
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    transacao: web::Json<TransacaoDto>,
) -> Result<HttpResponse> {
    let id = path.into_inner();

    // validate that the client exists
    let limite = match CLIENTS.get(&id) {
        Some(&lim) => lim,
        None => return Ok(HttpResponse::NotFound().finish()),
    };

    let transacao = transacao.into_inner();

    if !is_transacao_valid(&transacao) {
        return Ok(HttpResponse::UnprocessableEntity().finish());
    }

    // Execute the stored procedure InsertTransacao
    // Expected return: updated saldo (int)
    let row = sqlx::query!(
        r#"SELECT InsertTransacao($1, $2, $3, $4) as updated_saldo"#,
        id,
        transacao.valor,
        transacao.tipo,
        transacao.descricao
    )
    .fetch_one(pool.get_ref())
    .await
    .map_err(|_| HttpResponse::UnprocessableEntity().finish())?;

    let cliente = ClienteDto {
        id,
        limite,
        saldo: row.updated_saldo,
    };

    Ok(HttpResponse::Ok().json(cliente))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Retrieve the database URL from the environment. For example:
    // DATABASE_URL=postgres://postgres:postgres@db:5432/rinha
    let database_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    // Create a PostgreSQL connection pool.
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("Failed to create pool");

    println!("Starting server on http://0.0.0.0:8080");

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(pool.clone()))
            .service(get_extrato)
            .service(post_transacao)
            // Health check endpoint
            .route("/healthz", web::get().to(|| async {
                HttpResponse::Ok().body("Healthy")
            }))
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await
}