'use client';

import React, { useState } from 'react';
import { Upload, Download, Play, AlertCircle, CheckCircle, Loader } from 'lucide-react';

interface BusinessResult {
  stadt: string;
  branche: string;
  name?: string;
  adresse?: string;
  telefon?: string;
  website?: string;
  email?: string;
  status?: string;
}

export default function BusinessScraper() {
  const [file, setFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ 
    current: 0, 
    total: 0, 
    status: '', 
    searchCount: 0, 
    totalSearches: 0 
  });
  const [results, setResults] = useState<BusinessResult[] | null>(null);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (uploadedFile) {
      setFile(uploadedFile);
      setError('');
      setResults(null);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile && (droppedFile.name.endsWith('.xlsx') || droppedFile.name.endsWith('.xls') || droppedFile.name.endsWith('.csv'))) {
      setFile(droppedFile);
      setError('');
      setResults(null);
    } else {
      setError('Bitte nur Excel- oder CSV-Dateien hochladen');
    }
  };

  const startScraping = async () => {
    if (!file) {
      setError('Bitte laden Sie zuerst eine Datei hoch');
      return;
    }

    setProcessing(true);
    setError('');
    setResults(null);
    setProgress({ current: 0, total: 0, status: 'Starte...', searchCount: 0, totalSearches: 0 });

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/scrape', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Scraping fehlgeschlagen');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      const tempResults: BusinessResult[] = [];

      if (!reader) {
        throw new Error('Stream nicht verfügbar');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.type === 'progress') {
                setProgress({
                  current: data.current,
                  total: data.total,
                  status: data.message,
                  searchCount: data.searchCount,
                  totalSearches: data.totalSearches,
                });
              } else if (data.type === 'result') {
                tempResults.push(data.result);
                setResults([...tempResults]);
              } else if (data.type === 'complete') {
                setResults(data.results);
                setProgress({
                  current: data.results.length,
                  total: data.results.length,
                  status: data.message,
                  searchCount: 0,
                  totalSearches: 0,
                });
              } else if (data.type === 'error') {
                setError(data.message);
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ein Fehler ist aufgetreten');
    } finally {
      setProcessing(false);
    }
  };

  const downloadResults = () => {
    if (!results) return;

    const csv = [
      ['Stadt', 'Branche', 'Name', 'Adresse', 'Telefon', 'Website', 'Email', 'Status'].join(','),
      ...results.map((r: BusinessResult) => [
        r.stadt,
        r.branche,
        r.name || '',
        r.adresse || '',
        r.telefon || '',
        r.website || '',
        r.email || '',
        r.status || ''
      ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `scraping_ergebnisse_${Date.now()}.csv`;
    link.click();
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <h1 className="text-3xl font-bold text-gray-800 mb-2">Business Email Scraper</h1>
          <p className="text-gray-600 mb-8">
            Finde automatisch Kontaktdaten von Unternehmen über Google Places API
          </p>

          {/* Upload Section */}
          <div className="mb-8">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Excel-Datei hochladen (Stadt, Branche)
            </label>
            <div 
              className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                isDragging 
                  ? 'border-indigo-500 bg-indigo-50' 
                  : 'border-gray-300 hover:border-indigo-500'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileUpload}
                className="hidden"
                id="file-upload"
              />
              <label htmlFor="file-upload" className="cursor-pointer">
                <Upload className="mx-auto h-12 w-12 text-gray-400 mb-2" />
                <p className="text-sm text-gray-600">
                  {file ? file.name : 'Klicken zum Hochladen oder Datei hierher ziehen'}
                </p>
                <p className="text-xs text-gray-500 mt-1">XLSX, XLS oder CSV</p>
              </label>
            </div>
          </div>


          {/* Start Button */}
          <button
            onClick={startScraping}
            disabled={!file || processing}
            className="w-full bg-indigo-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
          >
            {processing ? (
              <>
                <Loader className="animate-spin mr-2" />
                Verarbeite...
              </>
            ) : (
              <>
                <Play className="mr-2" />
                Scraping starten
              </>
            )}
          </button>

          {/* Progress */}
          {processing && (
            <div className="mt-6 p-4 bg-indigo-50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-indigo-900">{progress.status}</span>
                <div className="text-right">
                  <div className="text-sm font-semibold text-indigo-700">
                    {progress.current} / {progress.total} Leads ({progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}%)
                  </div>
                  {progress.totalSearches > 0 && (
                    <div className="text-xs text-indigo-600 mt-1">
                      Durchlauf {progress.searchCount} von {progress.totalSearches}
                    </div>
                  )}
                </div>
              </div>
              <div className="w-full bg-indigo-200 rounded-full h-2">
                <div
                  className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-6 p-4 bg-red-50 rounded-lg border border-red-200">
              <p className="text-red-800 flex items-center">
                <AlertCircle className="w-5 h-5 mr-2" />
                {error}
              </p>
            </div>
          )}

          {/* Results */}
          {results && (
            <div className="mt-8">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-gray-800 flex items-center">
                  <CheckCircle className="w-6 h-6 mr-2 text-green-500" />
                  Ergebnisse ({results.length})
                </h2>
                <button
                  onClick={downloadResults}
                  className="bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 transition-colors flex items-center"
                >
                  <Download className="w-4 h-4 mr-2" />
                  CSV Download
                </button>
              </div>
              
              <div className="overflow-auto max-h-96 border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left font-semibold">Stadt</th>
                      <th className="px-4 py-2 text-left font-semibold">Branche</th>
                      <th className="px-4 py-2 text-left font-semibold">Name</th>
                      <th className="px-4 py-2 text-left font-semibold">Email</th>
                      <th className="px-4 py-2 text-left font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r: BusinessResult, i: number) => (
                      <tr key={i} className="border-t hover:bg-gray-50">
                        <td className="px-4 py-2">{r.stadt}</td>
                        <td className="px-4 py-2">{r.branche}</td>
                        <td className="px-4 py-2">{r.name || '-'}</td>
                        <td className="px-4 py-2">
                          {r.email ? (
                            <span className="text-green-600 font-medium">{r.email}</span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`text-xs px-2 py-1 rounded ${
                            r.status === 'success' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                          }`}>
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Instructions */}
          <div className="mt-8 p-4 bg-gray-50 rounded-lg text-sm text-gray-600">
            <h3 className="font-semibold text-gray-800 mb-2">So funktioniert's:</h3>
            <ol className="list-decimal list-inside space-y-1">
              <li>Excel-Datei mit Spalten "Stadt" und "Branche" hochladen</li>
              <li>Google Places API findet Unternehmen</li>
              <li>Websites werden nach Email-Adressen durchsucht</li>
              <li>Ergebnisse als CSV herunterladen</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}