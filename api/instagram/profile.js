export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { username } = req.query;
  if (!username) return res.status(400).json({ success: false, error: 'Username required' });

  try {
    const response = await fetch(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
      headers: {
        'X-IG-App-ID': '936619743392459',
        'User-Agent': 'Instagram 275.0.0.27.98 Android'
      }
    });

    if (!response.ok) return res.status(response.status).json({ success: false, error: `Instagram returned ${response.status}` });

    const data = await response.json();
    const user = data?.data?.user;
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const posts = (user.edge_owner_to_timeline_media?.edges || []).map(edge => ({
      id: edge.node.id,
      shortcode: edge.node.shortcode,
      displayUrl: edge.node.display_url,
      thumbnailUrl: edge.node.thumbnail_src || edge.node.display_url,
      caption: edge.node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
      likes: edge.node.edge_liked_by?.count || 0,
      comments: edge.node.edge_media_to_comment?.count || 0,
      isVideo: edge.node.is_video,
      timestamp: edge.node.taken_at_timestamp
    }));

    return res.status(200).json({
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
        isVerified: user.is_verified
      },
      posts
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
