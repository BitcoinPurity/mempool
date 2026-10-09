import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Inject, LOCALE_ID, NgZone, OnDestroy, OnInit } from '@angular/core';
import { FormControl, FormGroup, Validators } from '@angular/forms';
import { EMPTY, Subject, catchError, finalize, forkJoin, merge, switchMap, takeUntil, timer } from 'rxjs';
import { EChartsOption, echarts } from '@app/graphs/echarts';
import { PurityNode, PurityNodeSnapshot } from '@app/interfaces/purity-nodes.interface';
import { ApiService } from '@app/services/api.service';
import { AssetsService } from '@app/services/assets.service';
import { StateService } from '@app/services/state.service';

interface PurityMapPoint {
  name: string;
  value: number[];
  node: PurityNode;
  symbolOffset: number[];
  itemStyle: { color: string };
}

@Component({
  selector: 'app-purity-nodes-map',
  templateUrl: './purity-nodes-map.component.html',
  styleUrls: ['./purity-nodes-map.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PurityNodesMapComponent implements OnInit, OnDestroy {
  snapshot: PurityNodeSnapshot | null = null;
  chartOptions: EChartsOption = {};
  chartInitOptions = { renderer: 'svg' };
  chartInstance: echarts.ECharts | undefined;
  loading = true;
  loadError = false;
  submitting = false;
  showForm = false;
  showList = false;
  publicVisible = true;
  nonPublicVisible = true;
  publicCount = 0;
  nonPublicCount = 0;
  unlocatedCount = 0;
  selectedNode: PurityNode | null = null;
  submissionMessage = '';
  submissionError = false;
  publicLabel = $localize`:@@purity.nodes.public:Public P2P`;
  nonPublicLabel = $localize`:@@purity.nodes.non-public:Non-public / reachability unconfirmed`;
  archiveLabel = $localize`:@@purity.nodes.archive:Archive`;
  pruneLabel = $localize`:@@purity.nodes.prune:Prune`;
  unknownTypeLabel = $localize`:@@purity.nodes.unknown-type:Type unknown`;
  nodeTypeColors = { archive: '#37c89b', prune: '#5b9cf5', unknown: '#a1a7b3' };
  form = new FormGroup({
    host: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(
      /^(?:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)|(?=[0-9a-fA-F:.]*:)[0-9a-fA-F:.]{2,45})$/,
    )] }),
    port: new FormControl<number | null>(8333, [Validators.min(1), Validators.max(65535), Validators.pattern(/^\d+$/)]),
  });
  private refresh$ = new Subject<void>();
  private destroy$ = new Subject<void>();

  constructor(
    private api: ApiService,
    private assets: AssetsService,
    public state: StateService,
    private changeDetector: ChangeDetectorRef,
    private zone: NgZone,
    @Inject(LOCALE_ID) private locale: string,
  ) { }

  ngOnInit(): void {
    if (!this.state.isBrowser) { return; }
    merge(timer(0, 60000), this.refresh$).pipe(
      switchMap(() => {
        this.loading = true;
        this.loadError = false;
        this.changeDetector.markForCheck();
        return forkJoin({ snapshot: this.api.getPurityNodes$(), world: this.assets.getWorldMapJson$ }).pipe(
          catchError(() => {
            this.loadError = true;
            return EMPTY;
          }),
          finalize(() => {
            this.loading = false;
            this.changeDetector.markForCheck();
          }),
        );
      }),
      takeUntil(this.destroy$),
    ).subscribe(({ snapshot, world }) => {
      echarts.registerMap('purity-world', world);
      this.snapshot = snapshot;
      this.publicCount = snapshot.nodes.filter(node => node.p2p_reachable === 1).length;
      this.nonPublicCount = snapshot.nodes.length - this.publicCount;
      this.unlocatedCount = snapshot.nodes.filter(node => !node.location).length;
      this.selectedNode = this.selectedNode ? snapshot.nodes.find(node =>
        node.host === this.selectedNode!.host && node.port === this.selectedNode!.port) ?? null : null;
      this.updateChart();
      this.changeDetector.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  refresh(): void {
    this.refresh$.next();
  }

  endpoint(node: Pick<PurityNode, 'host' | 'port'>): string {
    return (node.host.includes(':') ? '[' + node.host + ']' : node.host) + ':' + node.port;
  }

  probeStatus(node: PurityNode): string {
    return node.p2p_reachable === 1 ? $localize`:@@purity.nodes.probe-success:Outbound P2P handshake succeeded` :
      node.p2p_reachable === 0 ? $localize`:@@purity.nodes.probe-failed:Recent probe failed` :
        $localize`:@@purity.nodes.probe-unknown:Not yet probed`;
  }

  location(node: PurityNode): string {
    return [node.location?.city, node.location?.country].filter(Boolean).join(', ') ||
      $localize`:@@purity.nodes.unknown-location:Location unavailable`;
  }

  nodeTypeLabel(node: PurityNode): string {
    return node.node_type === 'archive' ? this.archiveLabel : node.node_type === 'prune' ? this.pruneLabel : this.unknownTypeLabel;
  }

  onChartInit(chart: echarts.ECharts): void {
    this.chartInstance = chart;
    chart.on('click', (params: echarts.ECElementEvent) => {
      const point = params.data as PurityMapPoint | undefined;
      if (point?.node) {
        this.zone.run(() => {
          this.selectedNode = point.node;
          this.changeDetector.markForCheck();
        });
      }
    });
  }

  toggleCategory(isPublic: boolean): void {
    if (isPublic) { this.publicVisible = !this.publicVisible; }
    else { this.nonPublicVisible = !this.nonPublicVisible; }
    this.updateChart();
  }

  submit(): void {
    if (this.form.invalid || this.submitting) { return; }
    const { host, port } = this.form.getRawValue();
    this.submitting = true;
    this.submissionMessage = '';
    this.submissionError = false;
    this.api.addPurityNode$({ host: host.trim(), ...(port === null ? {} : { port }) }).pipe(
      takeUntil(this.destroy$),
      finalize(() => {
        this.submitting = false;
        this.changeDetector.markForCheck();
      }),
    ).subscribe({
      next: result => {
        const duplicate = result.added ? '' : $localize`:@@purity.nodes.duplicate:Node already exists and was rechecked.` + ' ';
        const verification = result.verification === 'purity' ? $localize`:@@purity.nodes.confirmed:Purity node confirmed.` :
          result.verification === 'other' ? $localize`:@@purity.nodes.other:This is not a Purity node.` :
            $localize`:@@purity.nodes.inconclusive:Verification was inconclusive. Only confirmed nodes appear on the map.`;
        this.submissionMessage = this.endpoint(result) + ': ' + duplicate + verification;
        this.submissionError = result.verification !== 'purity';
        this.refresh();
      },
      error: error => {
        this.submissionError = true;
        this.submissionMessage = error.status === 504 || error.status === 0 || error.name === 'TimeoutError' ?
          $localize`:@@purity.nodes.timeout:The verification result has not returned. Refresh the list later; the node may already have been added.` :
          error.status === 429 ? $localize`:@@purity.nodes.rate-limit:Too many verification requests. Please try again later.` :
          error.status === 400 ? $localize`:@@purity.nodes.invalid-input:Enter a public IPv4 or IPv6 address and an integer port from 1 to 65535.` :
            $localize`:@@purity.nodes.submit-error:Unable to obtain a verification result. Please refresh the list or try again later.`;
      },
    });
  }

  private updateChart(): void {
    const geo = (this.chartInstance?.getOption()?.geo as { center?: number[]; zoom?: number }[])?.[0];
    const groups = new Map<string, PurityMapPoint[]>();
    for (const node of this.snapshot?.nodes ?? []) {
      if (!node.location || !(node.p2p_reachable === 1 ? this.publicVisible : this.nonPublicVisible)) { continue; }
      const value = [node.location.longitude, node.location.latitude];
      const key = value.join(',');
      const group = groups.get(key) ?? [];
      group.push({ name: this.endpoint(node), value, node, symbolOffset: [0, 0],
        itemStyle: { color: this.nodeTypeColors[node.node_type] ?? this.nodeTypeColors.unknown } });
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length < 2) { continue; }
      // Offset overlapping symbols in pixels, preserving their GeoIP coordinates at every zoom level.
      const radius = Math.max(10, group.length * 3);
      group.forEach((point, index) => {
        const angle = 2 * Math.PI * index / group.length;
        point.symbolOffset = [Math.cos(angle) * radius, Math.sin(angle) * radius];
      });
    }
    const points = Array.from(groups.values()).flat();
    this.chartOptions = {
      animation: false,
      tooltip: {
        trigger: 'item', triggerOn: 'mousemove|click', renderMode: 'richText',
        formatter: (params: unknown): string => {
          const node = (params as { data: PurityMapPoint }).data.node;
          const verified = node.last_success ? new Date(node.last_success * 1000).toLocaleString(this.locale) :
            $localize`:@@purity.nodes.unknown-time:Unknown`;
          return [this.endpoint(node), this.location(node), this.nodeTypeLabel(node), this.probeStatus(node), node.user_agent,
            $localize`:@@purity.nodes.height:Height` + ': ' + node.height,
            $localize`:@@purity.nodes.verified-at:Last chain verification` + ': ' + verified].join('\n');
        },
      },
      geo: {
        map: 'purity-world', roam: true, silent: true,
        center: geo?.center ?? [0, 5], zoom: geo?.zoom ?? 1.2,
        scaleLimit: { min: 1, max: 100 },
        itemStyle: { color: 'var(--world-map-bg)', borderColor: 'var(--world-map-border)' },
        emphasis: { disabled: true },
      },
      series: [true, false].map(isPublic => ({
        name: isPublic ? this.publicLabel : this.nonPublicLabel,
        type: 'scatter', coordinateSystem: 'geo',
        z: isPublic ? 3 : 2,
        symbol: isPublic ? 'circle' : 'emptyDiamond', symbolSize: 10,
        data: points.filter(point => (point.node.p2p_reachable === 1) === isPublic),
      })),
    };
  }
}
