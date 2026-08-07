# List available commands
default:
    @just --list

# Install dependencies
[group("dev")]
setup:
    pnpm install

# Run the security test suite
[group("dev")]
test:
    pnpm run test

# Start the server
[group("dev")]
run:
    pnpm run start

# Deploy to Fly.io
[group("ship")]
deploy:
    fly deploy
