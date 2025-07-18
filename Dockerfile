FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install base tools and Node.js
RUN apt-get update && apt-get install -y \
    curl git clang libssl-dev pkg-config build-essential \
    unzip wget ca-certificates software-properties-common \
    protobuf-compiler \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Rust in a single layer with proper PATH
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y \
    && /root/.cargo/bin/rustup target add wasm32-unknown-unknown \
    && /root/.cargo/bin/rustup component add rust-src
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Pop CLI with ink! v6 support (polkavm-contracts feature)
RUN /root/.cargo/bin/cargo install pop-cli --no-default-features --locked -F polkavm-contracts,parachain,telemetry

# Set working directory
WORKDIR /app

# Copy package.json first for better caching
COPY package*.json ./

# Install Node.js dependencies with regular install
RUN npm install --only=production

# Copy application code
COPY server.js .

# Create directory for contracts
RUN mkdir -p /app/contracts

# Expose port
EXPOSE 3000

# Simple healthcheck without curl dependency
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', {timeout: 5000}, (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Verify installations work
RUN which node && which npm && which cargo && which pop \
    && node --version && npm --version \
    && /root/.cargo/bin/cargo --version \
    && /root/.cargo/bin/pop --version \
    && echo "POP CLI installed with ink! v6 support (polkavm-contracts feature)"

CMD ["node", "server.js"]
