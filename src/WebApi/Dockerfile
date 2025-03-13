FROM rust:1.85 AS builder

# Enable SQLx offline mode so SQLx uses the offline cache.
ENV SQLX_OFFLINE=1

WORKDIR /app

# Copy Cargo.toml and Cargo.lock to cache dependencies.
COPY Cargo.toml ./
COPY Cargo.lock ./

# Create a dummy main to allow caching of dependencies.
RUN echo "fn main() {}" > main.rs
RUN cargo build --release && rm -f target/release/deps/rinha2_back_end_bora_dale_xgh_rust*

# Now copy the full source and rebuild.
COPY . .

RUN cargo build --release

# Run stage: a small runtime image.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*

# Copy the built binary from the builder stage.
COPY --from=builder /app/target/release/rinha2-back-end-bora-dale-xgh-rust /usr/local/bin/app

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/app"]