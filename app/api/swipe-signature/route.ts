import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { address, taskType, proof, checkOnly } = body || {};

    if (!address || !taskType) {
      return NextResponse.json(
        { success: false, error: 'Missing address or taskType' },
        { status: 400 }
      );
    }

    const upstream = await fetch('https://swipe-market.vercel.app/api/daily-tasks/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address,
        taskType,
        proof,
        checkOnly,
      }),
      cache: 'no-store',
    });

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      return NextResponse.json(
        { success: false, error: data?.error || 'Upstream error', upstreamStatus: upstream.status },
        { status: 502 }
      );
    }

    return NextResponse.json(data, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e?.message || 'Unknown error' },
      { status: 500 }
    );
  }
}
