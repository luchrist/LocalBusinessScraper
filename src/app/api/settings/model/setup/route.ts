import { NextResponse } from 'next/server';
import { modelSetupState, startModelSetup } from '@/lib/model-download';
export async function GET() { return NextResponse.json(await modelSetupState(), { headers: { 'Cache-Control': 'no-store' } }); }
export async function POST() { return NextResponse.json(await startModelSetup(), { headers: { 'Cache-Control': 'no-store' } }); }
