const axios = require('axios');

if (!global.mediaLibrary) global.mediaLibrary = [];
if (!global.scraperConfig) global.scraperConfig = { accounts: [], intervalHours: 1, enabled: false, lastRun: null };

function extractUsername(input) {
    if (!input) return null;
    input = input.trim().replace(/^@/, '');
    const match = input.match(/instagram\.com\/([^\/\?]+)/);
    if (match) return match[1];
    if (/^[a-zA-Z0-9_.]+$/.test(input)) return input;
    return null;
}

async function getInstagramData(username) {
    const response = await axios.get(
        `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
        {
            headers: {
                'User-Agent': 'Instagram 219.0.0.12.117 Android',
                'X-IG-App-ID': '936619743392459'
            },
            timeout: 15000
        }
    );
    return response.data?.data?.user;
}

function addToLibrary(posts, accountUsername) {
    let newCount = 0;
    const now = new Date().toISOString();
    
    posts.forEach(post => {
        if (!global.mediaLibrary.find(item => item.id === post.id)) {
            global.mediaLibrary.unshift({
                ...post,
                libraryId: `lib_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                importedAt: now,
                sourceAccount: accountUsername,
                used: false
            });
            newCount++;
        }
    });
    
    global.mediaLibrary.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    if (global.mediaLibrary.length > 500) global.mediaLibrary = global.mediaLibrary.slice(0, 500);
    
    return newCount;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    // POST - Add new account
    if (req.method === 'POST') {
        try {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const username = extractUsername(body?.username);
            
            if (!username) {
                return res.status(400).json({ success: false, error: 'Invalid username' });
            }
            
            if (global.scraperConfig.accounts.find(a => a.username === username)) {
                return res.status(400).json({ success: false, error: 'Account already added' });
            }
            
            const user = await getInstagramData(username);
            
            if (!user) {
                return res.status(400).json({ success: false, error: 'User not found' });
            }
            
            if (user.is_private) {
                return res.status(400).json({ success: false, error: 'Private account' });
            }
            
            global.scraperConfig.accounts.push({
                username: user.username,
                addedAt: new Date().toISOString(),
                profilePic: user.profile_pic_url_hd || user.profile_pic_url,
                fullName: user.full_name,
                followers: user.edge_followed_by?.count || 0
            });
            
            // Import posts
            const posts = (user.edge_owner_to_timeline_media?.edges || []).map(edge => ({
                id: edge.node.id,
                shortcode: edge.node.shortcode,
                displayUrl: edge.node.display_url,
                thumbnailUrl: edge.node.thumbnail_src || edge.node.display_url,
                caption: edge.node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                likes: edge.node.edge_liked_by?.count || edge.node.edge_media_preview_like?.count || 0,
                comments: edge.node.edge_media_to_comment?.count || 0,
                timestamp: edge.node.taken_at_timestamp,
                date: new Date(edge.node.taken_at_timestamp * 1000).toISOString(),
                isVideo: edge.node.is_video
            }));
            
            const newCount = addToLibrary(posts, username);
            
            return res.json({
                success: true,
                message: `Added @${username} (${newCount} posts imported)`,
                config: global.scraperConfig
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }
    
    // GET - List accounts
    return res.json({ success: true, accounts: global.scraperConfig.accounts });
};
