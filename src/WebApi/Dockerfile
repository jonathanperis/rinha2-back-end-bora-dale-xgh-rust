FROM rust:1.85 as builder

# Accept DATABASE_URL as a build argument and set it as an environment variable.
ARG DATABASE_URL
ENV DATABASE_URL ${DATABASE_URL}

WORKDIR /app

# Cache dependencies by first copying Cargo.toml and Cargo.lock.
COPY Cargo.toml ./

# Create a dummy main to allow caching of dependencies.
RUN echo "fn main() {}" > main.rs
RUN cargo build --release && rm -f target/release/deps/rinha2_back_end_bora_dale_xgh_rust*

# Now copy the full source and rebuild.
COPY . .

RUN cargo build --release

# Run stage: a small runtime image.
FROM debian:buster-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy the built binary from the builder stage.
COPY --from=builder /app/target/release/rinha2-back-end-bora-dale-xgh-rust /usr/local/bin/app

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/app"]