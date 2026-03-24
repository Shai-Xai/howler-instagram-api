export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { shortcode } = req.query;
  if (!shortcode) return res.status(400).json({ success: false, error: 'Shortcode required' });

  try {
    const response = await fetch(`https://api.instagram.com/oembed/?url=https://www.instagram.com/p/${shortcode}/`);
    
    if (!response.ok) {
      return res.status(404).json({ success: false, error: 'Post not found or is private' });
    }
    
    const data = await response.json();
    return res.status(200).json({
      success: true,
      thumbnailUrl: data.thumbnail_url,
      caption: data.title || '',
      authorName: data.author_name || ''
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
