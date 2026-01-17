export const runtime = "nodejs";

export async function POST(request) {
  try {
    await new Promise((res) => setTimeout(res, 1200));

    // Tiny valid MP4 header (base64)
    const base64Mp4 =
      "AAAAIGZ0eXBtcDQyAAAAAG1wNDJtcDQxaXNvbQ==";

    return new Response(
      JSON.stringify({
        success: true,
        base64: base64Mp4,
        filename: `promptcut-output-${Date.now()}.mp4`,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false }),
      { status: 500 }
    );
  }
}
