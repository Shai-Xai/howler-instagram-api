const axios = require('axios');

// Helper functions
function extractUsername(input) {
    if (!input) return null;
    input = input.trim().replace(/^@/, '');
    const match = input.match(/instagram\.com\/([^\/\?]+)/);
    if (match) return match[1];
    if (/^[a-zA-Z0-9_.]+$/.test(input)) return input;
    return null;
}

async function getInstagramData(username) {
    try {
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

        const user = response.data?.data?.user;
        if (!user) return { success: false, error: 'User not found' };

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
            posts: (user.edge_owner_to_timeline_media?.edges || []).map(edge => ({
                id: edge.node.id,
                shortcode: edge.node.shortcode,
                displayUrl: edge.node.display_url,
                thumbnailUrl: edge.node.thumbnail_src || edge.node.display_url,
                caption: edge.node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                likes: edge.node.edge_liked_by?.count || edge.node.edge_media_preview_like?.count || 0,
                comments: edge.node.edge_media_to_comment?.count || 0,
                timestamp: edge.node.taken_at_timestamp,
                isVideo: edge.node.is_video
            }))
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Root endpoint
    return res.json({
        status: 'ok',
        message: 'Howler Instagram API',
        endpoints: {
            '/api/instagram/[username]': 'Fetch Instagram profile and posts',
            '/api/proxy': 'Proxy Instagram images'
        }
    });
};
