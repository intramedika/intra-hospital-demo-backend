# IntraHospital Demo Backend

Backend demo untuk IntraHospital SOAP Voice Assistant.

## Features

- Demo authentication
- MFA/TOTP enrollment and verification
- 10 demo doctor accounts
- Admin reset MFA endpoint
- GraphQL endpoint
- Speech/voice API integration
- Local JSON-based user storage for demo usage

## Local Development

Install dependencies:

    npm install

Run development server:

    npm run dev

Default backend URL:

    http://localhost:3000

## Environment

Create `.env` from `.env.example`:

    cp .env.example .env

Example `.env`:

    PORT=3000
    ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000,http://localhost:8088,http://demo.intrahospital.intramedika.co.id,https://demo.intrahospital.intramedika.co.id
    DEMO_ADMIN_RESET_ENABLED=true
    DEMO_ADMIN_KEY=change-me-demo-admin-key
    MFA_DEMO_BYPASS_ENABLED=false

Do not commit `.env`.

## Demo Accounts

All demo accounts use:

    Password: Demo123!

Available usernames:

    dokter.demo
    dokter.demo2
    dokter.demo3
    dokter.demo4
    dokter.demo5
    dokter.demo6
    dokter.demo7
    dokter.demo8
    dokter.demo9
    dokter.demo10

Each account has its own MFA/TOTP setup.

## Test Login

    curl -i http://localhost:3000/api/auth/login \
      -H "Content-Type: application/json" \
      -X POST \
      --data '{"username":"dokter.demo","password":"Demo123!"}'

If MFA is not enrolled, the response should include:

    mfaEnrollmentRequired: true
    enrollmentToken: ...

## MFA Setup

After login returns `enrollmentToken`, call:

    curl -i http://localhost:3000/api/auth/mfa/setup \
      -H "Content-Type: application/json" \
      -X POST \
      --data '{"enrollmentToken":"<TOKEN>"}'

The response includes an `otpauthUrl` that can be rendered as QR code or entered manually in an Authenticator app.

## Admin Reset MFA

Admin can reset MFA for a demo account so the next login shows a new QR code.

Set `.env`:

    DEMO_ADMIN_RESET_ENABLED=true
    DEMO_ADMIN_KEY=change-me-demo-admin-key

Reset one account:

    curl -i -X POST http://localhost:3000/api/admin/users/dokter.demo2/reset-mfa \
      -H "x-demo-admin-key: change-me-demo-admin-key"

Resetting MFA only changes:

    mfaEnabled
    mfaEnrolled
    mfaType
    totpSecret
    pendingTotpSecret

It does not change username, password hash, doctor name, role, unit, or demo scope.

## Reset All Demo MFA Accounts

    for u in dokter.demo dokter.demo2 dokter.demo3 dokter.demo4 dokter.demo5 dokter.demo6 dokter.demo7 dokter.demo8 dokter.demo9 dokter.demo10; do
      echo "Reset MFA: $u"
      curl -s -X POST "http://localhost:3000/api/admin/users/$u/reset-mfa" \
        -H "x-demo-admin-key: change-me-demo-admin-key"
      echo
    done

## User Data

Demo users are stored in:

    data/users.json

Passwords are stored as salted hashes. Do not store plaintext passwords.

The script for generating demo users is:

    scripts/generate-users.mjs

Use carefully, because regenerating users resets salts, password hashes, and MFA state.

## Production Demo Notes

VM backend path:

    /opt/intrahospital-demo/backend

Production demo URL:

    https://demo.intrahospital.intramedika.co.id

After updating environment variables on the VM:

    pm2 restart intrahospital-backend --update-env
    pm2 save

## Security Notes

Do not commit:

    .env
    secrets
    node_modules
    build artifacts
    backup files

Keep `DEMO_ADMIN_KEY` only in local or VM environment files.
