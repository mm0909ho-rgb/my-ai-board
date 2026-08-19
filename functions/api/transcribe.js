// Cloudflare Pages Function: 负责接收前端音频，并安全地带上 API Key 转发给 Groq
export async function onRequestPost(context) {
  try {
    // 1. 从 Cloudflare 后台的环境变量中读取藏好的 GROQ_API_KEY
    const apiKey = context.env.GROQ_API_KEY;
    
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "服务器端未配置 GROQ_API_KEY，请检查环境变量设置。" }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. 获取前端发送过来的 FormData (包含音频文件和参数)
    const formData = await context.request.formData();

    // 3. 由服务器发向 Groq API（在服务器端带上 Authorization 请求头）
    const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData
    });

    const data = await groqResponse.json();

    // 4. 将 Groq 的转录结果直接返回给前端
    return new Response(JSON.stringify(data), {
      status: groqResponse.status,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
