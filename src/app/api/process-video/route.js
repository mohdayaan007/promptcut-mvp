export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    console.log("Received:", body);

    // Fake processing delay
    await new Promise((res) => setTimeout(res, 1500));

    // Minimal fake MP4 binary (serverless-safe)
    const fakeMp4Content = Buffer.from(
      "00000020667479706D703432000000006D7034326D70343169736F6D",
      "hex"
    );

    return new Response(fakeMp4Content, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="promptcut-output-${Date.now()}.mp4"`,
      },
      status: 200,
    });
  } catch (error) {
    console.error("ERROR:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Processing failed",
      }),
      { status: 500 }
    );
  }
}
