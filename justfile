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

# Rotate a recovery token in place on this machine (admin | host | all)
[group("keys")]
remint role="admin":
    node server.js remint {{role}}

# Print fresh single-use magic sign-in links for this machine
[group("keys")]
links role="all":
    node server.js links {{role}}

# Fly.io: rotate a recovery token on the running app — no restart, nobody signed out
[group("ship")]
fly-remint role="admin":
    fly ssh console -C "node /app/server.js remint {{role}}"

# Fly.io: print fresh magic sign-in links for the running app (locked out? start here)
[group("ship")]
fly-links role="all":
    fly ssh console -C "node /app/server.js links {{role}}"
