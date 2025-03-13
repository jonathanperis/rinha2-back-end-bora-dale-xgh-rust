import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend } from 'k6/metrics';

// Base URL is read from environment variable. Defaults to localhost if not provided.
const baseUrl = __ENV.BASE_URL || "http://localhost:9999";

// -----------------------------------------------------------------------------
// Custom Trend Metrics
// We are creating two Trend metrics to track the duration of requests per endpoint:
// - transacoesTrend: used for endpoints that hit /clientes/:id/transacoes (credit/debit requests)
// - extratoTrend: used for endpoints that hit /clientes/:id/extrato (statement request)
// -----------------------------------------------------------------------------
export let transacoesTrend = new Trend('transacoes_duration', true);
export let extratoTrend = new Trend('extrato_duration', true);

// -----------------------------------------------------------------------------
// Utility functions to generate random test data.
// -----------------------------------------------------------------------------
const randomClienteId = () => Math.floor(Math.random() * 5) + 1;
const randomValorTransacao = () => Math.floor(Math.random() * 10000) + 1;
const randomDescricao = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

// Validate that the client's current balance does not exceed its allowed negative limit.
const validateSaldoLimite = (saldo, limite) => {
  return saldo >= limite * -1;
};

// Shared data for initial client balances is stored in a SharedArray for better performance.
const saldosIniciaisClientes = new SharedArray('clientes', () => [
  { id: 1, limite: 1000 * 100 },
  { id: 2, limite: 800 * 100 },
  { id: 3, limite: 10000 * 100 },
  { id: 4, limite: 100000 * 100 },
  { id: 5, limite: 5000 * 100 },
]);

// -----------------------------------------------------------------------------
// k6 Options and Scenarios
// Each scenario specifies a different test group:
// - validacoes: performs validation tests for client limits and balance consistency.
// - cliente_nao_encontrado: tests the “not found” case.
// - debitos and creditos: simulate ramping up virtual users (VUs) for debit and credit operations.
// - extratos: simulates retrieval of a client's statement.
// -----------------------------------------------------------------------------
export const options = {
  scenarios: {
    validacoes: {
      executor: 'per-vu-iterations',
      vus: saldosIniciaisClientes.length,
      iterations: 1,
      startTime: '0s',
      exec: 'validacoes',
    },
    cliente_nao_encontrado: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      startTime: '0s',
      exec: 'cliente_nao_encontrado',
    },
    debitos: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '2m', target: 220 },
        { duration: '2m', target: 220 },
      ],
      startTime: '10s',
      exec: 'debitos',
    },
    creditos: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '2m', target: 110 },
        { duration: '2m', target: 110 },
      ],
      startTime: '10s',
      exec: 'creditos',
    },
    extratos: {
      executor: 'per-vu-iterations',
      vus: 10,
      iterations: 1,
      startTime: '10s',
      exec: 'extratos',
    },
  },
};

// -----------------------------------------------------------------------------
// Helper function to record the response duration to the correct Trend metric.
// It checks the URL to decide whether to record this in the transacoesTrend or extratoTrend.
// -----------------------------------------------------------------------------
function recordDuration(url, res) {
  if (url.includes('/transacoes')) {
    transacoesTrend.add(res.timings.duration);
  } else if (url.includes('/extrato')) {
    extratoTrend.add(res.timings.duration);
  }
}

// -----------------------------------------------------------------------------
// Test function for debit transactions
// -----------------------------------------------------------------------------
export function debitos() {
  const payload = JSON.stringify({
    valor: randomValorTransacao(),
    tipo: 'd',                   // 'd' indicates debit
    descricao: randomDescricao(),
  });
  
  const url = `${baseUrl}/clientes/${randomClienteId()}/transacoes`;
  const res = http.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: '/clientes/:id/transacoes' },
  });

  // Adds request duration to the correct Trend metric.
  recordDuration(url, res);

  // Check if status is either 200 OK or 422 for invalid/debit cases.
  check(res, {
    'status 200 or 422': (r) => [200, 422].includes(r.status),
  });

  // Validate JSON response if status is 200.
  if (res.status === 200) {
    check(res, {
      'Consistência saldo/limite': (r) => {
        try {
          const saldo = r.json('saldo');
          const limite = r.json('limite');
          return validateSaldoLimite(saldo, limite);
        } catch (e) {
          return false;
        }
      }
    });
  }
}

// -----------------------------------------------------------------------------
// Test function for credit transactions
// -----------------------------------------------------------------------------
export function creditos() {
  const payload = JSON.stringify({
    valor: randomValorTransacao(),
    tipo: 'c',                   // 'c' indicates credit
    descricao: randomDescricao(),
  });

  const url = `${baseUrl}/clientes/${randomClienteId()}/transacoes`;
  const res = http.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: '/clientes/:id/transacoes' },
  });

  // Record response duration for credit transactions.
  recordDuration(url, res);

  check(res, {
    'status 200': (r) => r.status === 200,
  });

  // Validate if status is 200 then check JSON consistency.
  if (res.status === 200) {
    check(res, {
      'Consistência saldo/limite': (r) => {
        try {
          const saldo = r.json('saldo');
          const limite = r.json('limite');
          return validateSaldoLimite(saldo, limite);
        } catch (e) {
          return false;
        }
      }
    });
  }
}

// -----------------------------------------------------------------------------
// Test function for fetching client statements (extratos)
// -----------------------------------------------------------------------------
export function extratos() {
  const url = `${baseUrl}/clientes/${randomClienteId()}/extrato`;
  const res = http.get(url, {
    tags: { endpoint: '/clientes/:id/extrato' },
  });
  
  // Record duration for statement request.
  recordDuration(url, res);

  check(res, {
    'status 200': (r) => r.status === 200,
  });

  // Validate that the statement's balance and limit are consistent.
  if (res.status === 200) {
    check(res, {
      'Consistência extrato': (r) => {
        try {
          return validateSaldoLimite(
            r.json('saldo.total'),
            r.json('saldo.limite')
          );
        } catch (e) {
          return false;
        }
      }
    });
  }
}

// -----------------------------------------------------------------------------
// Test function for validations that includes multiple steps:
// 1. Checking initial GET for statement correctness.
// 2. Posting credit and debit transactions and validating the JSON consistency.
// 3. Testing invalid requests with various incorrect payloads.
// -----------------------------------------------------------------------------
export function validacoes() {
  // Each virtual user accesses a different client from our SharedArray.
  const index = (__VU - 1) % saldosIniciaisClientes.length;
  const cliente = saldosIniciaisClientes[index];
  
  group('Validações cliente', () => {
    let url = `${baseUrl}/clientes/${cliente.id}/extrato`;
    // GET request to check the client's current statement.
    let res = http.get(url, { tags: { endpoint: '/clientes/:id/extrato' } });
    recordDuration(url, res);

    check(res, {
      'status 200': (r) => r.status === 200,
      'limite correto': (r) => r.json('saldo.limite') === cliente.limite,
      'saldo inicial 0': (r) => r.json('saldo.total') === 0,
    });

    url = `${baseUrl}/clientes/${cliente.id}/transacoes`;
    // POST a credit transaction.
    res = http.post(
      url,
      JSON.stringify({ valor: 1, tipo: 'c', descricao: 'toma' }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { endpoint: '/clientes/:id/transacoes' },
      }
    );
    recordDuration(url, res);
    check(res, {
      'status 200': (r) => r.status === 200,
      'Consistência saldo/limite': (r) =>
        validateSaldoLimite(r.json('saldo'), r.json('limite')),
    });

    // POST a debit transaction.
    res = http.post(
      url,
      JSON.stringify({ valor: 1, tipo: 'd', descricao: 'devolve' }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { endpoint: '/clientes/:id/transacoes' },
      }
    );
    recordDuration(url, res);
    check(res, {
      'status 200': (r) => r.status === 200,
      'Consistência saldo/limite': (r) =>
        validateSaldoLimite(r.json('saldo'), r.json('limite')),
    });

    sleep(1);

    url = `${baseUrl}/clientes/${cliente.id}/extrato`;
    // GET request to verify recent transactions.
    res = http.get(url, { tags: { endpoint: '/clientes/:id/extrato' } });
    recordDuration(url, res);
    check(res, {
      'transações recentes': (r) => {
        const transacoes = r.json('ultimas_transacoes');
        return transacoes &&
          transacoes.length >= 2 &&
          transacoes[0].descricao === 'devolve' &&
          transacoes[0].tipo === 'd' &&
          transacoes[1].descricao === 'toma' &&
          transacoes[1].tipo === 'c';
      },
    });

    // Testing invalid requests with various incorrect inputs.
    const invalidRequests = [
      { valor: 1.2, tipo: 'd', descricao: 'devolve', expectedStatus: 422 },
      { valor: 1, tipo: 'x', descricao: 'devolve', expectedStatus: 422 },
      { valor: 1, tipo: 'c', descricao: '123456789 e mais', expectedStatus: 422 },
      { valor: 1, tipo: 'c', descricao: '', expectedStatus: 422 },
      { valor: 1, tipo: 'c', descricao: null, expectedStatus: 422 },
    ];

    invalidRequests.forEach((req) => {
      url = `${baseUrl}/clientes/${cliente.id}/transacoes`;
      res = http.post(url, JSON.stringify(req), {
        headers: { 'Content-Type': 'application/json' },
        tags: { endpoint: '/clientes/:id/transacoes' },
      });
      recordDuration(url, res);
      check(res, {
        [`status ${req.expectedStatus}`]: (r) =>
          r.status === req.expectedStatus || r.status === 400,
      });
    });
  });
}

// -----------------------------------------------------------------------------
// Test for client not found scenario.
// It confirms that querying for an non-existent client (id 6) returns a 404.
// -----------------------------------------------------------------------------
export function cliente_nao_encontrado() {
  const url = `${baseUrl}/clientes/6/extrato`;
  const res = http.get(url, { tags: { endpoint: '/clientes/:id/extrato' } });
  recordDuration(url, res);
  check(res, {
    'status 404': (r) => r.status === 404,
  });
}

// -----------------------------------------------------------------------------
// handleSummary - Custom Summary Output
// This function is called at the end of test execution. We use it to:
// 1. Build a summary object that groups our custom Trend metrics by endpoint.
// 2. Generate an offline HTML dashboard (offline_dashboard_report.html) that shows key metrics.
// -----------------------------------------------------------------------------
export function handleSummary(data) {
  const customSummary = {
    endpoints: {
      '/clientes/:id/transacoes': {
        avg: data.metrics.transacoes_duration.values.avg || 0,
        min: data.metrics.transacoes_duration.values.min || 0,
        max: data.metrics.transacoes_duration.values.max || 0,
        p95: data.metrics.transacoes_duration.values["p(95)"] || 0,
      },
      '/clientes/:id/extrato': {
        avg: data.metrics.extrato_duration.values.avg || 0,
        min: data.metrics.extrato_duration.values.min || 0,
        max: data.metrics.extrato_duration.values.max || 0,
        p95: data.metrics.extrato_duration.values["p(95)"] || 0,
      },
    },
  };

  // Generate an offline HTML dashboard report.
  const reportHtml = generateHtmlReport(customSummary);

  return {
    stdout: JSON.stringify(customSummary, null, 2),
    "stress-test-report.html": reportHtml,
  };
}

// Helper function to generate an HTML report using summary data.
function generateHtmlReport(summary) {
  return `
<html>
  <head>
    <meta charset="utf-8">
    <title>Offline Dashboard Report</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; }
      h1 { color: #333; }
      table { width: 600px; border-collapse: collapse; }
      th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
      th { background-color: #eee; }
    </style>
  </head>
  <body>
    <h1>Custom Offline Dashboard Report</h1>
    <h2>Metrics Grouped by Endpoint</h2>
    <table>
      <tr>
        <th>Endpoint</th>
        <th>Avg Duration (ms)</th>
        <th>Min Duration (ms)</th>
        <th>Max Duration (ms)</th>
        <th>p(95) (ms)</th>
      </tr>
      <tr>
        <td>/clientes/:id/transacoes</td>
        <td>${summary.endpoints["/clientes/:id/transacoes"].avg.toFixed(2)}</td>
        <td>${summary.endpoints["/clientes/:id/transacoes"].min.toFixed(2)}</td>
        <td>${summary.endpoints["/clientes/:id/transacoes"].max.toFixed(2)}</td>
        <td>${summary.endpoints["/clientes/:id/transacoes"].p95.toFixed(2)}</td>
      </tr>
      <tr>
        <td>/clientes/:id/extrato</td>
        <td>${summary.endpoints["/clientes/:id/extrato"].avg.toFixed(2)}</td>
        <td>${summary.endpoints["/clientes/:id/extrato"].min.toFixed(2)}</td>
        <td>${summary.endpoints["/clientes/:id/extrato"].max.toFixed(2)}</td>
        <td>${summary.endpoints["/clientes/:id/extrato"].p95.toFixed(2)}</td>
      </tr>
    </table>
  </body>
</html>
  `;
}