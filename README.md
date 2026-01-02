# Howler Instagram API

A Node.js backend service for scraping Instagram public profiles and posts.

## Features

- Fetch public Instagram profile information
- Retrieve recent posts with images, captions, and engagement metrics
- Multiple scraping methods with automatic fallbacks
- Image proxy to avoid CORS issues
- Rate limiting to prevent abuse
- Support for carousel/multi-image posts

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment (Optional)

```bash
cp .env.example .env
```

Edit `.env` if you need to change the port or add proxy settings.

### 3. Start the Server

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

The server will start on `http://localhost:3001` by default.

## API Endpoints

### GET /
Health check and API info.

### GET /api/instagram/:username
Fetch profile and posts for a username.

**Example:**
```
GET /api/instagram/howler_events
GET /api/instagram/@howler_events
GET /api/instagram/https://instagram.com/howler_events
```

**Response:**
```json
{
  "success": true,
  "profile": {
    "username": "howler_events",
    "fullName": "Howler Events",
    "bio": "Your event discovery platform",
    "profilePic": "https://...",
    "followers": 12400,
    "following": 500,
    "postsCount": 150,
    "isPrivate": false,
    "isVerified": true,
    "isBusiness": true
  },
  "posts": [
    {
      "id": "123456",
      "shortcode": "ABC123",
      "type": "GraphImage",
      "displayUrl": "https://...",
      "thumbnailUrl": "https://...",
      "caption": "Amazing event last night! 🎉",
      "likes": 234,
      "comments": 45,
      "timestamp": 1704067200,
      "date": "2024-01-01T00:00:00.000Z",
      "isVideo": false,
      "videoUrl": null
    }
  ]
}
```

### POST /api/instagram/fetch
Fetch profile with username in request body.

**Body:**
```json
{
  "username": "howler_events"
}
```

### GET /api/proxy/image?url=...
Proxy Instagram images to avoid CORS issues.

## Deployment

### Vercel

1. Install Vercel CLI: `npm i -g vercel`
2. Run: `vercel`
3. Follow the prompts

### Railway

1. Connect your GitHub repo to Railway
2. Railway will auto-detect and deploy

### Heroku

1. Install Heroku CLI
2. Run:
```bash
heroku create howler-instagram-api
git push heroku main
```

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["node", "server.js"]
```

## Limitations

- **Rate Limiting:** Instagram may block requests if too many are made
- **Private Profiles:** Cannot access posts from private accounts
- **Data Freshness:** Posts are fetched in real-time, no caching
- **Terms of Service:** Use responsibly and in compliance with Instagram's ToS

## Troubleshooting

### "Failed to fetch Instagram data"
- The profile may be private
- Instagram may be rate limiting your IP
- Try again after a few minutes

### Images not loading
- Use the `/api/proxy/image` endpoint to proxy images
- Instagram CDN URLs expire after some time

### CORS errors
- Make sure your frontend URL is allowed in the CORS config
- Use the image proxy for displaying Instagram images

## Updating the CMS

Update your Howler CMS to use this API:

```javascript
const API_URL = 'http://localhost:3001'; // or your deployed URL

async function fetchInstagramPosts(username) {
    const response = await fetch(`${API_URL}/api/instagram/${username}`);
    const data = await response.json();
    
    if (data.success) {
        return data.posts;
    } else {
        throw new Error(data.error);
    }
}
```

## License

MIT
