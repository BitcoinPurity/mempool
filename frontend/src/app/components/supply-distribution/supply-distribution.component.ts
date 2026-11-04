import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Inject, LOCALE_ID, OnDestroy, OnInit } from '@angular/core';
import { formatNumber } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, Subscription, catchError, debounceTime, distinctUntilChanged, filter, forkJoin, map, of, skip, switchMap } from 'rxjs';
import { EChartsOption } from '@app/graphs/echarts';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { SeoService } from '@app/services/seo.service';
import { SupplyBucket, SupplyDistribution, SupplyTopAddresses } from '@interfaces/supply-distribution.interface';

const COIN = 100_000_000;
const PAGE_SIZE = 100;

type ChartMetric = 'amount' | 'scripts';

@Component({
  selector: 'app-supply-distribution',
  templateUrl: './supply-distribution.component.html',
  styleUrls: ['./supply-distribution.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SupplyDistributionComponent implements OnInit, OnDestroy {
  distribution: SupplyDistribution | null = null;
  top: SupplyTopAddresses | null = null;
  page = 1;
  pageSize = PAGE_SIZE;
  isLoading = true;
  error: 'no_data' | 'error' | null = null;
  metric: ChartMetric = 'amount';
  chartOptions: EChartsOption = {};
  chartInitOptions = { renderer: 'svg' };
  paginationMaxSize = window.matchMedia('(max-width: 670px)').matches ? 3 : 5;

  private refresh$ = new Subject<void>();
  private subscriptions: Subscription[] = [];

  constructor(
    @Inject(LOCALE_ID) private locale: string,
    private apiService: ApiService,
    public stateService: StateService,
    private seoService: SeoService,
    private route: ActivatedRoute,
    private router: Router,
    private cd: ChangeDetectorRef,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle($localize`:@@supply.title:Supply Distribution`);
    this.seoService.setDescription($localize`:@@supply.meta-description:See how the entire coin supply since the genesis block is distributed across addresses: balance ranges, top addresses (rich list) and UTXO counts, updated with every block.`);

    this.subscriptions.push(
      this.refresh$.pipe(
        switchMap(() => forkJoin([
          this.apiService.getSupplyDistribution$(),
          this.apiService.getSupplyTopAddresses$(this.page, this.pageSize),
        ]).pipe(
          map(([distribution, top]) => ({ distribution, top, error: null })),
          catchError((e: HttpErrorResponse) => of({ distribution: null, top: null, error: e?.status === 404 ? 'no_data' as const : 'error' as const })),
        )),
      ).subscribe(({ distribution, top, error }) => {
        this.isLoading = false;
        this.error = error;
        if (distribution && top) {
          const changed = !this.distribution || this.distribution.height !== distribution.height ||
            this.distribution.hash !== distribution.hash || this.distribution.status !== distribution.status;
          this.distribution = distribution;
          this.top = top;
          if (changed) {
            this.prepareChart();
          }
        }
        this.cd.markForCheck();
      }),
      this.route.queryParamMap.subscribe((params) => {
        const page = parseInt(params.get('page') || '1', 10);
        this.page = Number.isInteger(page) && page > 0 ? page : 1;
        this.isLoading = true;
        this.cd.markForCheck();
        this.refresh$.next();
      }),
      // New blocks move the data forward; refetch shortly after each new tip.
      this.stateService.chainTip$.pipe(
        filter((height) => height > 0),
        distinctUntilChanged(),
        skip(1),
        debounceTime(5000),
      ).subscribe(() => this.refresh$.next()),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }

  pageChange(page: number): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: { page }, queryParamsHandling: 'merge' });
  }

  setMetric(metric: ChartMetric): void {
    this.metric = metric;
    this.prepareChart();
  }

  bucketLabel(bucket: SupplyBucket): string {
    const format = (sats: number): string => {
      const btc = sats / COIN;
      return btc >= 1000 ? formatNumber(btc / 1000, this.locale, '1.0-0') + 'k' : formatNumber(btc, this.locale, '1.0-3');
    };
    if (bucket.maxSats === null) {
      return '≥ ' + format(bucket.minSats);
    }
    return bucket.minSats === 0 ? '< ' + format(bucket.maxSats) : format(bucket.minSats) + ' – ' + format(bucket.maxSats);
  }

  percent(part: number, whole: number): number {
    return whole > 0 ? (part / whole) * 100 : 0;
  }

  trackByBucket(_index: number, bucket: SupplyBucket): number {
    return bucket.bucket;
  }

  trackByRank(_index: number, row: { rank: number }): number {
    return row.rank;
  }

  private prepareChart(): void {
    if (!this.distribution) {
      return;
    }
    const buckets = this.distribution.buckets;
    const total = this.metric === 'amount' ? this.distribution.totalAmount : this.distribution.scriptCount;
    const values = buckets.map((b) => this.metric === 'amount' ? b.amount : b.scriptCount);
    this.chartOptions = {
      animation: false,
      grid: { left: 70, right: 20, top: 20, bottom: 60 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(17, 19, 31, 1)',
        borderRadius: 4,
        shadowColor: 'rgba(0, 0, 0, 0.5)',
        textStyle: { color: 'var(--tooltip-grey)', align: 'left' },
        borderColor: '#000',
        formatter: (params: any): string => {
          const bucket = buckets[params[0].dataIndex];
          const btc = formatNumber(bucket.amount / COIN, this.locale, '1.0-2');
          const amountShare = formatNumber(this.percent(bucket.amount, this.distribution.totalAmount), this.locale, '1.2-2');
          const scriptShare = formatNumber(this.percent(bucket.scriptCount, this.distribution.scriptCount), this.locale, '1.2-2');
          return `<b>${this.bucketLabel(bucket)} BTC</b><br>` +
            `${$localize`:@@supply.addresses:Addresses`}: ${formatNumber(bucket.scriptCount, this.locale, '1.0-0')} (${scriptShare}%)<br>` +
            `${$localize`:@@supply.amount:Amount`}: ${btc} BTC (${amountShare}%)`;
        },
      },
      xAxis: {
        type: 'category',
        data: buckets.map((b) => this.bucketLabel(b)),
        axisLabel: { color: 'var(--grey)', rotate: 30, fontSize: 11 },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: 'var(--grey)', formatter: (value: number): string => `${formatNumber(value, this.locale, value >= 10 ? '1.0-0' : '1.0-2')}%` },
        splitLine: { lineStyle: { type: 'dotted', color: 'var(--transparent-fg)', opacity: 0.25 } },
      },
      series: [{
        type: 'bar',
        data: values.map((value) => this.percent(value, total)),
        itemStyle: { color: this.metric === 'amount' ? '#FDD835' : '#1E88E5', borderRadius: [3, 3, 0, 0] },
        barMaxWidth: 48,
      }],
    };
  }
}
