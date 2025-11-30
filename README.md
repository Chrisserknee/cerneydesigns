# CerneyDesigns Website

A professional web design services website with integrated payment processing.

## Features

- 🎨 Modern, responsive design
- 📝 Design request form
- 💳 Stripe payment integration
- 📊 Request management system
- 🚀 Easy server startup

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Stripe

1. Create a `.env` file in the project root (copy from `.env.example`)
2. Get your Stripe API keys from https://dashboard.stripe.com/apikeys
3. Add them to the `.env` file:
   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_PUBLISHABLE_KEY=pk_test_...
   ```

### 3. Start the Server

**Option 1: Using the .bat file (Windows)**
- Double-click `start-server.bat` on your desktop

**Option 2: Using npm**
```bash
npm start
```

**Option 3: Development mode (with auto-restart)**
```bash
npm run dev
```

The server will start on `http://localhost:3000`

## Project Structure

```
CerneyDesigns/
├── index.html          # Main HTML file
├── styles.css          # Stylesheet
├── script.js           # Frontend JavaScript
├── server.js           # Express server
├── package.json        # Dependencies
├── .env.example        # Environment variables template
├── data/               # Data storage (auto-created)
│   └── requests.json   # Design requests database
└── README.md           # This file
```

## API Endpoints

- `POST /api/submit-request` - Submit a design request
- `POST /api/create-payment-intent` - Create Stripe payment intent
- `POST /api/update-payment-status` - Update payment status after successful payment
- `GET /api/requests` - Get all requests (for admin)

## Payment Flow

1. Client fills out the design request form
2. Form submission creates a request record
3. Client is redirected to payment section
4. Payment is processed via Stripe
5. Request status is updated to "paid"

## Notes

- The server stores requests in `data/requests.json`
- Make sure to use Stripe test keys for development
- Replace test keys with live keys for production

## Support

For issues or questions, contact info@cerneydesigns.com



