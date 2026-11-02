import express from 'express';

const app = express();
const supportedCurrencies = new Set(['EUR', 'ILS', 'USD']);

type SdmxResponse = {
  data: {
    dataSets: Array<{
      series: Record<
        string,
        { observations: Record<string, [number | string, ...unknown[]]> }
      >;
    }>;
    structure: {
      dimensions: {
        series: Array<{
          id: string;
          values: Array<{ id: string }>;
        }>;
        observation: Array<{
          values: Array<{ id: string }>;
        }>;
      };
    };
  };
};

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function getBankOfIsraelRate(
  source: string,
  target: string,
  requestedDate?: string,
) {
  const today = new Date();
  const parsedDate = requestedDate
    ? new Date(`${requestedDate}T00:00:00Z`)
    : today;
  const endDate =
    Number.isNaN(parsedDate.getTime()) || parsedDate > today
      ? today
      : parsedDate;
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 10);

  const currencies = [source, target].filter(code => code !== 'ILS');
  const seriesCodes = currencies.map(code => `RER_${code}_ILS`).join(',');
  const url = new URL(
    'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/',
  );
  url.searchParams.set('c[SERIES_CODE]', seriesCodes);
  url.searchParams.set('startperiod', formatDate(startDate));
  url.searchParams.set('endperiod', formatDate(endDate));
  url.searchParams.set('format', 'sdmx-json');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Bank of Israel request failed: ${response.status}`);
  }

  const body = (await response.json()) as SdmxResponse;
  const seriesDimension = body.data.structure.dimensions.series.find(
    dimension => dimension.id === 'SERIES_CODE',
  );
  const timeValues =
    body.data.structure.dimensions.observation[0]?.values ?? [];
  const ratesByCurrency = new Map<string, Map<string, number>>();

  for (const [seriesKey, series] of Object.entries(
    body.data.dataSets[0]?.series ?? {},
  )) {
    const seriesIndex = Number(seriesKey.split(':')[0]);
    const seriesCode = seriesDimension?.values[seriesIndex]?.id;
    const currency = seriesCode?.match(/^RER_([A-Z]{3})_ILS$/)?.[1];
    if (!currency) {
      continue;
    }

    const observations = new Map<string, number>();
    for (const [timeIndex, observation] of Object.entries(
      series.observations,
    )) {
      const date = timeValues[Number(timeIndex)]?.id;
      const rate = Number(observation[0]);
      if (date && Number.isFinite(rate) && rate > 0) {
        observations.set(date, rate);
      }
    }
    ratesByCurrency.set(currency, observations);
  }

  const availableDates = currencies
    .map(currency => new Set(ratesByCurrency.get(currency)?.keys() ?? []))
    .reduce<Set<string> | null>((commonDates, dates) => {
      if (commonDates == null) {
        return dates;
      }
      return new Set([...commonDates].filter(date => dates.has(date)));
    }, null);
  const rateDate = [...(availableDates ?? [])].sort().at(-1);
  if (!rateDate) {
    throw new Error('Bank of Israel returned no rate for this date');
  }

  const sourceIlsRate =
    source === 'ILS' ? 1 : ratesByCurrency.get(source)?.get(rateDate);
  const targetIlsRate =
    target === 'ILS' ? 1 : ratesByCurrency.get(target)?.get(rateDate);
  if (!sourceIlsRate || !targetIlsRate) {
    throw new Error('Bank of Israel response was missing a currency rate');
  }

  return {
    source,
    target,
    rate: sourceIlsRate / targetIlsRate,
    date: rateDate,
  };
}

app.get('/bank-of-israel', async (req, res) => {
  const source = String(req.query.source ?? '');
  const target = String(req.query.target ?? '');
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;

  if (!supportedCurrencies.has(source) || !supportedCurrencies.has(target)) {
    return res.status(400).json({ error: 'Unsupported currency' });
  }

  try {
    return res.json(await getBankOfIsraelRate(source, target, date));
  } catch (error) {
    return res.status(502).json({
      error: error instanceof Error ? error.message : 'Exchange-rate error',
    });
  }
});

export { app as handlers };
