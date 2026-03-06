
'use client';

import React, { useState, useEffect } from 'react';
import { Trash2, Plus, RefreshCw, Eye, EyeOff, AlertTriangle } from 'lucide-react';

interface ApiKey {
  key: string;
  usage: number;
  added_at: number;
}

interface SettingsTabProps {
  singleWorker: boolean;
  setSingleWorker: (val: boolean) => void;
  enrichmentWorkerCount: number;
  setEnrichmentWorkerCount: (val: number) => void;
}

export default function SettingsTab({ 
  singleWorker,
  setSingleWorker,
  enrichmentWorkerCount,
  setEnrichmentWorkerCount
}: SettingsTabProps) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKey, setNewKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchKeys();
  }, []);

  const fetchKeys = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/settings/keys');
      if (!res.ok) throw new Error('Failed to fetch keys');
      const data = await res.json();
      setKeys(data);
    } catch (e) {
      setError('Could not load API keys');
    } finally {
      setLoading(false);
    }
  };

  const addKey = async () => {
    if (!newKey.trim()) return;
    try {
      const res = await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: newKey.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to add key');
      }
      setNewKey('');
      fetchKeys();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const deleteKey = async (key: string) => {
    if (!confirm('Are you sure you want to delete this API key?')) return;
    try {
      const res = await fetch('/api/settings/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) throw new Error('Failed to delete key');
      fetchKeys();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const resetUsage = async (key: string) => {
    try {
      const res = await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, action: 'reset' }),
      });
      if (!res.ok) throw new Error('Failed to reset usage');
      fetchKeys();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const toggleShowKey = (k: string) => {
    setShowKeys(prev => ({ ...prev, [k]: !prev[k] }));
  };

  const maskKey = (k: string) => {
    if (k.length <= 8) return '********';
    return `${k.substring(0, 4)}...${k.substring(k.length - 4)}`;
  };

  return (
    <div className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow-sm border border-gray-200">
      <h2 className="text-2xl font-bold mb-6 text-gray-800">Google Places API Settings</h2>
      
      <div className="mb-8">
        <h3 className="text-lg font-semibold mb-3 text-gray-700">Add New Key</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="Paste your Google Places API Key here"
            className="flex-1 p-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
          <button
            onClick={addKey}
            disabled={!newKey.trim()}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            <Plus size={18} /> Add
          </button>
        </div>
        {error && <p className="text-red-500 mt-2 text-sm">{error}</p>}
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-3 text-gray-700">Managed Keys</h3>
        <p className="text-sm text-gray-500 mb-4">
            Keys are automatically rotated when usage reaches 1000 calls.
            The system tracks usage including pagination requests.
        </p>
        
        {loading ? (
          <div className="text-center py-8">Loading...</div>
        ) : keys.length === 0 ? (
          <div className="text-center py-8 text-gray-500 border-2 border-dashed border-gray-200 rounded">
            No API keys configured. Please add at least one key to start scraping.
          </div>
        ) : (
          <div className="space-y-4">
            {keys.map((k) => (
              <div key={k.key} className="flex items-center justify-between p-4 bg-gray-50 rounded border border-gray-100">
                <div className="flex-1 min-w-0 mr-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-gray-800 truncate block">
                      {showKeys[k.key] ? k.key : maskKey(k.key)}
                    </span>
                    <button onClick={() => toggleShowKey(k.key)} className="text-gray-400 hover:text-gray-600">
                      {showKeys[k.key] ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <div className="text-xs text-gray-400">
                    Added: {new Date(k.added_at).toLocaleDateString()}
                  </div>
                </div>

                <div className="flex items-center gap-6">
                    <div className="text-right">
                        <div className="text-sm font-medium text-gray-600">Usage</div>
                        <div className={`text-lg font-bold ${k.usage >= 1000 ? 'text-red-600' : 'text-green-600'}`}>
                            {k.usage} <span className="text-xs text-gray-400 font-normal">/ 1000</span>
                        </div>
                    </div>
                    
                    <div className="flex gap-2">
                         <button 
                            onClick={() => resetUsage(k.key)}
                            title="Reset Usage Count"
                            className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded"
                        >
                            <RefreshCw size={18} />
                        </button>
                        <button 
                            onClick={() => deleteKey(k.key)}
                            title="Delete Key"
                            className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded"
                        >
                            <Trash2 size={18} />
                        </button>
                    </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

       <div className="border-t pt-6 mt-8">
        <h3 className="text-lg font-semibold mb-3 text-gray-700">Performance Settings</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-100">
            <div>
              <div className="font-medium text-gray-800">Enrichment Worker</div>
              <div className="text-sm text-gray-500">Number of parallel tasks for Email & Owner scraping.<br/>(Auto: RAM &le;8 GB &rarr; 1, &le;16 GB &rarr; 2, &gt;16 GB &rarr; 3)</div>
            </div>
            <div className="flex gap-1">
              {[0, 1, 2, 3, 4, 5].map(n => (
                <button
                  key={n}
                  onClick={() => setEnrichmentWorkerCount(n)}
                  className={`px-3 h-9 rounded-lg text-sm font-semibold transition-colors ${
                    enrichmentWorkerCount === n
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  {n === 0 ? 'Auto' : n}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

       <div className="border-t pt-6 mt-8">
        <h3 className="text-lg font-semibold mb-3 text-gray-700">Debug Settings</h3>
        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-100">
          <div>
            <div className="font-medium text-gray-800">Test Mode (Single Worker)</div>
            <div className="text-sm text-gray-500">Forces the scraper to use only 1 worker to make logs cleaner.</div>
          </div>
          <button
            onClick={() => setSingleWorker(!singleWorker)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              singleWorker ? 'bg-indigo-600' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                singleWorker ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

    </div>
  );
}
