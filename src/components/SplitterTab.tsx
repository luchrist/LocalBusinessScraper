import React, { useState } from 'react';
import { Upload, Download, FileSpreadsheet, Loader, AlertCircle } from 'lucide-react';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

type Operator = '<' | '<=' | '==' | '>=' | '>' | '!=' | 'contains' | 'not contains';

export default function SplitterTab() {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [columns, setColumns] = useState<string[]>([]);
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  
  const [selectedColumn, setSelectedColumn] = useState<string>('');
  const [operator, setOperator] = useState<Operator>('<=');
  const [conditionValue, setConditionValue] = useState<string>('');
  
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

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

  const processFile = async (uploadedFile: File) => {
    setFile(uploadedFile);
    setError('');
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const result = e.target?.result;
        const workbook = XLSX.read(result, { type: 'binary' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        // Convert to array of objects to easily read columns and perform filtering
        const jsonData = XLSX.utils.sheet_to_json(worksheet) as Record<string, unknown>[];
        
        if (jsonData.length > 0) {
          const cols = Object.keys(jsonData[0] as object);
          setColumns(cols);
          setData(jsonData);
          setSelectedColumn(cols[0] || '');
        } else {
          setError('Die Datei ist leer oder hat kein unterstütztes Format.');
        }
      } catch {
        setError('Fehler beim Lesen der Datei. Bitte stellen Sie sicher, dass es sich um eine gültige CSV- oder Excel-Datei handelt.');
      }
    };

    reader.onerror = () => {
      setError('Fehler beim Lesen der Datei.');
    };

    reader.readAsBinaryString(uploadedFile);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile && (droppedFile.name.endsWith('.xlsx') || droppedFile.name.endsWith('.xls') || droppedFile.name.endsWith('.csv'))) {
      processFile(droppedFile);
    } else {
      setError('Bitte nur Excel- oder CSV-Dateien hochladen.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (uploadedFile) {
      if (uploadedFile.name.endsWith('.xlsx') || uploadedFile.name.endsWith('.xls') || uploadedFile.name.endsWith('.csv')) {
        processFile(uploadedFile);
      } else {
        setError('Bitte nur Excel- oder CSV-Dateien hochladen.');
      }
    }
  };

  const evaluateCondition = (recordValue: unknown, op: Operator, targetValue: string) => {
    if (recordValue === null || recordValue === undefined) {
        recordValue = '';
    }
    
    // Convert both to strings for text comparison, but check if they are numbers for numeric comparison
    const strRecord = String(recordValue).trim().toLowerCase();
    const strTarget = targetValue.trim().toLowerCase();
    
    const numRecord = Number(recordValue);
    const numTarget = Number(targetValue);
    
    // If both look like valid numbers and not empty strings
    const isNumericTest = !isNaN(numRecord) && !isNaN(numTarget) && strRecord !== '' && strTarget !== '';

    switch (op) {
      case '==':
        return isNumericTest ? numRecord === numTarget : strRecord === strTarget;
      case '!=':
        return isNumericTest ? numRecord !== numTarget : strRecord !== strTarget;
      case '<':
        return isNumericTest ? numRecord < numTarget : strRecord < strTarget;
      case '<=':
        return isNumericTest ? numRecord <= numTarget : strRecord <= strTarget;
      case '>':
        return isNumericTest ? numRecord > numTarget : strRecord > strTarget;
      case '>=':
        return isNumericTest ? numRecord >= numTarget : strRecord >= strTarget;
      case 'contains':
        return strRecord.includes(strTarget);
      case 'not contains':
        return !strRecord.includes(strTarget);
      default:
        return false;
    }
  };

  const handleSplitAndDownload = async () => {
    if (!file || data.length === 0 || !selectedColumn) return;
    
    setProcessing(true);
    setError('');
    
    try {
      // Split the data
      const matchData: Record<string, unknown>[] = [];
      const noMatchData: Record<string, unknown>[] = [];
      
      data.forEach(row => {
        const val = row[selectedColumn];
        if (evaluateCondition(val, operator, conditionValue)) {
          matchData.push(row);
        } else {
          noMatchData.push(row);
        }
      });
      
      // Create workbooks
      const matchWs = XLSX.utils.json_to_sheet(matchData);
      const noMatchWs = XLSX.utils.json_to_sheet(noMatchData);
      
      // Convert workbooks to CSV string
      const matchCsv = XLSX.utils.sheet_to_csv(matchWs);
      const noMatchCsv = XLSX.utils.sheet_to_csv(noMatchWs);
      
      // Create ZIP
      const zip = new JSZip();
      
      // Add a BOM to ensure Excel opens the CSVs with utf-8 correctly
      const bom = '\uFEFF';
      zip.file(`matching_${operator}_${conditionValue}.csv`, bom + matchCsv);
      zip.file(`not_matching.csv`, bom + noMatchCsv);
      
      // Generate ZIP blob
      const content = await zip.generateAsync({ type: 'blob' });
      
      // Trigger download
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `split_results_${file.name.replace(/\.[^/.]+$/, '')}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
    } catch (err) {
      setError('Fehler beim Splitten und Zippen der Datei. ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
          <FileSpreadsheet className="w-5 h-5 text-indigo-600" />
          CSV Splitter
        </h2>
        
        <p className="text-sm text-gray-600 mb-6">
          Laden Sie eine CSV- oder Excel-Datei hoch, wählen Sie eine Spalte als Bedingung, und laden Sie die Zeilen aufgeteilt in zwei CSV-Dateien als ZIP herunter.
        </p>

        {/* Upload Area */}
        <div className="mb-6">
          <div 
            className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
              isDragging 
                ? 'border-indigo-500 bg-indigo-50' 
                : file ? 'border-green-300 bg-green-50' : 'border-gray-300 hover:border-indigo-500'
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
              id="splitter-file-upload"
            />
            <label htmlFor="splitter-file-upload" className="cursor-pointer block">
              <Upload className={`mx-auto h-10 w-10 mb-2 ${file ? 'text-green-500' : 'text-gray-400'}`} />
              <p className="text-sm font-medium text-gray-700">
                {file ? file.name : 'Zum Hochladen klicken oder Datei hier ablegen'}
              </p>
              {!file && <p className="text-xs text-gray-500 mt-1">XLSX, XLS oder CSV</p>}
              {file && data.length > 0 && <p className="text-xs text-green-600 mt-1">{data.length} Zeilen geladen</p>}
            </label>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-lg flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {/* Condition Form */}
        {columns.length > 0 && (
          <div className="space-y-4 bg-gray-50 p-4 rounded-lg border border-gray-200">
            <h3 className="text-sm font-medium text-gray-700">Split Bedingung</h3>
            
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">Spalte</label>
                <select 
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  value={selectedColumn}
                  onChange={(e) => setSelectedColumn(e.target.value)}
                >
                  {columns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
              
              <div className="w-full sm:w-32">
                <label className="block text-xs text-gray-500 mb-1">Operator</label>
                <select 
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  value={operator}
                  onChange={(e) => setOperator(e.target.value as Operator)}
                >
                  <option value="<">&lt;</option>
                  <option value="<=">&lt;=</option>
                  <option value="==">==</option>
                  <option value=">=">&gt;=</option>
                  <option value=">">&gt;</option>
                  <option value="!=">!=</option>
                  <option value="contains">Enthält</option>
                  <option value="not contains">Enthält nicht</option>
                </select>
              </div>
              
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">Wert</label>
                <input 
                  type="text" 
                  value={conditionValue}
                  onChange={(e) => setConditionValue(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="z.B. 50 oder Text..."
                />
              </div>
            </div>
            
            <div className="pt-2">
              <button
                onClick={handleSplitAndDownload}
                disabled={processing || !file || data.length === 0}
                className="w-full bg-indigo-600 text-white py-2.5 px-4 rounded-lg font-medium hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {processing ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    Verarbeitung...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    Zippen & Herunterladen
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
