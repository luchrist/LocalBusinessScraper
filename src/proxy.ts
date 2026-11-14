import { NextRequest, NextResponse } from 'next/server';
// Desktop requests receive a per-launch secret from Electron. Other browser
// origins and local programs cannot call the packaged server without it.
export function proxy(req: NextRequest) {
  const secret = process.env.AUTOSETTER_LOCAL_TOKEN;
  if (secret && req.headers.get('x-autosetter-local-token') !== secret) return new NextResponse('Forbidden', { status: 403 });
  const origin = req.headers.get('origin');
  if (req.nextUrl.pathname.startsWith('/api/') && origin && origin !== req.nextUrl.origin && new URL(origin).host !== req.headers.get('host')) return new NextResponse('Forbidden', { status: 403 });
  return NextResponse.next();
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
