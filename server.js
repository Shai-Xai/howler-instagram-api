const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting simple implementation
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute

function checkRateLimit(ip) {
    const now = Date.now();
    const userRequests = rateLimitMap.get(ip) || [];
    const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (recentRequests.length >= RATE_LIMIT_MAX) {
        return false;
    }
    
    recentRequests.push(now);
    rateLimitMap.set(ip, recentRequests);
    return true;
}

// Helper function to extract username from URL or handle raw username
function extractUsername(input) {
    if (!input) return null;
    
    // Remove @ symbol if present
    input = input.trim().replace(/^@/, '');
    
    // Handle full URLs
    const urlPatterns = [
        /instagram\.com\/([^\/\?]+)/,
        /instagr\.am\/([^\/\?]+)/
    ];
    
    for (const pattern of urlPatterns) {
        const match = input.match(pattern);
        if (match) {
            return match[1];
        }
    }
    
    // Return as-is if it looks like a username
    if (/^[a-zA-Z0-9_.]+$/.test(input)) {
        return input;
    }
    
    return null;
}

// User agent rotation
const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
];

function getRandomUserAgent() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Method 1: Scrape using Instagram's web interface
async function scrapeInstagramProfile(username) {
    try {
        const response = await axios.get(`https://www.instagram.com/${username}/`, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0'
            },
            timeout: 15000
        });

        const html = response.data;
        
        // Try to find the shared data JSON
        const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.+?});<\/script>/);
        if (sharedDataMatch) {
            const sharedData = JSON.parse(sharedDataMatch[1]);
            return parseSharedData(sharedData, username);
        }

        // Try alternative data format
        const additionalDataMatch = html.match(/window\.__additionalDataLoaded\s*\([^,]+,\s*({.+?})\);/);
        if (additionalDataMatch) {
            const additionalData = JSON.parse(additionalDataMatch[1]);
            return parseAdditionalData(additionalData, username);
        }

        // Try to find data in meta tags as fallback
        return scrapeMetaTags(html, username);

    } catch (error) {
        console.error('Scrape error:', error.message);
        throw error;
    }
}

// Parse _sharedData format
function parseSharedData(data, username) {
    try {
        const user = data.entry_data?.ProfilePage?.[0]?.graphql?.user;
        if (!user) {
            throw new Error('Could not find user data');
        }

        const posts = user.edge_owner_to_timeline_media?.edges || [];
        
        return {
            success: true,
            profile: {
                username: user.username,
                fullName: user.full_name,
                bio: user.biography,
                profilePic: user.profile_pic_url_hd || user.profile_pic_url,
                followers: user.edge_followed_by?.count || 0,
                following: user.edge_follow?.count || 0,
                postsCount: user.edge_owner_to_timeline_media?.count || 0,
                isPrivate: user.is_private,
                isVerified: user.is_verified,
                isBusiness: user.is_business_account
            },
            posts: posts.map(edge => parsePost(edge.node))
        };
    } catch (error) {
        throw new Error('Failed to parse shared data: ' + error.message);
    }
}

// Parse additional data format
function parseAdditionalData(data, username) {
    try {
        const user = data.graphql?.user || data.user;
        if (!user) {
            throw new Error('Could not find user data');
        }

        const posts = user.edge_owner_to_timeline_media?.edges || [];
        
        return {
            success: true,
            profile: {
                username: user.username,
                fullName: user.full_name,
                bio: user.biography,
                profilePic: user.profile_pic_url_hd || user.profile_pic_url,
                followers: user.edge_followed_by?.count || 0,
                following: user.edge_follow?.count || 0,
                postsCount: user.edge_owner_to_timeline_media?.count || 0,
                isPrivate: user.is_private,
                isVerified: user.is_verified,
                isBusiness: user.is_business_account
            },
            posts: posts.map(edge => parsePost(edge.node))
        };
    } catch (error) {
        throw new Error('Failed to parse additional data: ' + error.message);
    }
}

// Parse individual post
function parsePost(node) {
    const post = {
        id: node.id,
        shortcode: node.shortcode,
        type: node.__typename,
        displayUrl: node.display_url,
        thumbnailUrl: node.thumbnail_src || node.display_url,
        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
        likes: node.edge_liked_by?.count || node.edge_media_preview_like?.count || 0,
        comments: node.edge_media_to_comment?.count || 0,
        timestamp: node.taken_at_timestamp,
        date: new Date(node.taken_at_timestamp * 1000).toISOString(),
        isVideo: node.is_video,
        videoUrl: node.video_url || null,
        accessibilityCaption: node.accessibility_caption || ''
    };

    // Handle carousel posts
    if (node.edge_sidecar_to_children) {
        post.carouselMedia = node.edge_sidecar_to_children.edges.map(edge => ({
            id: edge.node.id,
            displayUrl: edge.node.display_url,
            isVideo: edge.node.is_video,
            videoUrl: edge.node.video_url || null
        }));
    }

    return post;
}

// Fallback: scrape meta tags
function scrapeMetaTags(html, username) {
    const $ = cheerio.load(html);
    
    const ogImage = $('meta[property="og:image"]').attr('content');
    const ogDescription = $('meta[property="og:description"]').attr('content');
    const ogTitle = $('meta[property="og:title"]').attr('content');
    
    // Parse description for follower count
    let followers = 0;
    let following = 0;
    let postsCount = 0;
    
    if (ogDescription) {
        const followersMatch = ogDescription.match(/([\d,.]+[KMB]?)\s*Followers/i);
        const followingMatch = ogDescription.match(/([\d,.]+[KMB]?)\s*Following/i);
        const postsMatch = ogDescription.match(/([\d,.]+[KMB]?)\s*Posts/i);
        
        if (followersMatch) followers = parseCount(followersMatch[1]);
        if (followingMatch) following = parseCount(followingMatch[1]);
        if (postsMatch) postsCount = parseCount(postsMatch[1]);
    }

    return {
        success: true,
        profile: {
            username: username,
            fullName: ogTitle?.replace(/@\w+.*$/, '').trim() || username,
            bio: '',
            profilePic: ogImage || '',
            followers,
            following,
            postsCount,
            isPrivate: false,
            isVerified: false,
            isBusiness: false
        },
        posts: [],
        notice: 'Limited data available. Instagram may be blocking detailed scraping.'
    };
}

// Parse count strings like "1.2K", "5M"
function parseCount(str) {
    if (!str) return 0;
    str = str.replace(/,/g, '');
    const num = parseFloat(str);
    if (str.includes('K')) return Math.round(num * 1000);
    if (str.includes('M')) return Math.round(num * 1000000);
    if (str.includes('B')) return Math.round(num * 1000000000);
    return Math.round(num);
}

// Method 2: Use Instagram's GraphQL API (more reliable but may require session)
async function fetchViaGraphQL(username) {
    try {
        // First get the user ID
        const profileResponse = await axios.get(`https://www.instagram.com/${username}/?__a=1&__d=dis`, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'application/json',
                'X-IG-App-ID': '936619743392459',
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 15000
        });

        if (profileResponse.data && profileResponse.data.graphql) {
            return parseSharedData({ entry_data: { ProfilePage: [profileResponse.data] } }, username);
        }
        
        throw new Error('GraphQL method failed');
    } catch (error) {
        console.error('GraphQL error:', error.message);
        throw error;
    }
}

// Method 3: Use i.instagram.com API
async function fetchViaMobileAPI(username) {
    try {
        const searchResponse = await axios.get(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
            headers: {
                'User-Agent': 'Instagram 219.0.0.12.117 Android',
                'X-IG-App-ID': '936619743392459'
            },
            timeout: 15000
        });

        const user = searchResponse.data?.data?.user;
        if (!user) {
            throw new Error('User not found');
        }

        const posts = user.edge_owner_to_timeline_media?.edges || [];

        return {
            success: true,
            profile: {
                username: user.username,
                fullName: user.full_name,
                bio: user.biography,
                profilePic: user.profile_pic_url_hd || user.profile_pic_url,
                followers: user.edge_followed_by?.count || 0,
                following: user.edge_follow?.count || 0,
                postsCount: user.edge_owner_to_timeline_media?.count || 0,
                isPrivate: user.is_private,
                isVerified: user.is_verified,
                isBusiness: user.is_business_account
            },
            posts: posts.map(edge => parsePost(edge.node))
        };
    } catch (error) {
        console.error('Mobile API error:', error.message);
        throw error;
    }
}

// Main scraping function with fallbacks
async function getInstagramData(username) {
    const errors = [];

    // Try Method 1: Mobile API (most reliable currently)
    try {
        console.log(`Trying mobile API for ${username}...`);
        return await fetchViaMobileAPI(username);
    } catch (error) {
        errors.push(`Mobile API: ${error.message}`);
    }

    // Try Method 2: GraphQL
    try {
        console.log(`Trying GraphQL for ${username}...`);
        return await fetchViaGraphQL(username);
    } catch (error) {
        errors.push(`GraphQL: ${error.message}`);
    }

    // Try Method 3: Web scraping
    try {
        console.log(`Trying web scraping for ${username}...`);
        return await scrapeInstagramProfile(username);
    } catch (error) {
        errors.push(`Web scraping: ${error.message}`);
    }

    // All methods failed
    return {
        success: false,
        error: 'Failed to fetch Instagram data',
        details: errors,
        suggestion: 'The profile may be private, or Instagram is blocking requests. Try again later.'
    };
}

// ============ API ROUTES ============

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Howler Instagram API',
        endpoints: {
            'GET /api/instagram/:username': 'Fetch Instagram profile and posts',
            'GET /api/instagram/:username/posts': 'Fetch only posts',
            'POST /api/instagram/fetch': 'Fetch with username in body'
        }
    });
});

// Get Instagram profile and posts by username
app.get('/api/instagram/:username', async (req, res) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    
    if (!checkRateLimit(clientIP)) {
        return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded. Please wait a minute before trying again.'
        });
    }

    const username = extractUsername(req.params.username);
    
    if (!username) {
        return res.status(400).json({
            success: false,
            error: 'Invalid username or URL provided'
        });
    }

    try {
        console.log(`Fetching Instagram data for: ${username}`);
        const data = await getInstagramData(username);
        
        if (data.success && data.profile.isPrivate) {
            return res.json({
                success: true,
                profile: data.profile,
                posts: [],
                notice: 'This is a private profile. Posts cannot be accessed.'
            });
        }
        
        res.json(data);
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch Instagram data',
            message: error.message
        });
    }
});

// POST endpoint for fetching
app.post('/api/instagram/fetch', async (req, res) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    
    if (!checkRateLimit(clientIP)) {
        return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded. Please wait a minute before trying again.'
        });
    }

    const { username, url } = req.body;
    const input = username || url;
    
    if (!input) {
        return res.status(400).json({
            success: false,
            error: 'Please provide a username or URL'
        });
    }

    const extractedUsername = extractUsername(input);
    
    if (!extractedUsername) {
        return res.status(400).json({
            success: false,
            error: 'Invalid username or URL provided'
        });
    }

    try {
        console.log(`Fetching Instagram data for: ${extractedUsername}`);
        const data = await getInstagramData(extractedUsername);
        res.json(data);
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch Instagram data',
            message: error.message
        });
    }
});

// Proxy endpoint for images (to avoid CORS issues)
app.get('/api/proxy/image', async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'URL parameter required' });
    }

    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': getRandomUserAgent()
            },
            timeout: 10000
        });

        const contentType = response.headers['content-type'];
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(response.data);
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).json({ error: 'Failed to fetch image' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Howler Instagram API running on port ${PORT}`);
    console.log(`📍 Local: http://localhost:${PORT}`);
});

module.exports = app;
