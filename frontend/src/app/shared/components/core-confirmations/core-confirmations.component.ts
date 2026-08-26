import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core';
import { BehaviorSubject, Subscription, combineLatest, of } from 'rxjs';
import { catchError, distinctUntilChanged, filter, map, startWith, switchMap } from 'rxjs/operators';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';

@Component({
  selector: 'app-core-confirmations',
  templateUrl: './core-confirmations.component.html',
  styleUrls: ['./core-confirmations.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CoreConfirmationsComponent implements OnInit, OnChanges, OnDestroy {
  @Input() txid: string;
  @Input() buttonClass: string = '';

  loaded = false;
  found = false;
  confirmations = 0;

  private txid$ = new BehaviorSubject<string | null>(null);
  private subscription: Subscription;

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private ref: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    // Refresh when local tip advances, but do not wait for it (startWith).
    const refreshTrigger$ = this.stateService.blocks$.pipe(
      map((blocks) => blocks[0]?.height ?? null),
      startWith(null),
      distinctUntilChanged(),
    );

    this.subscription = combineLatest([
      this.txid$.pipe(filter((txid): txid is string => !!txid), distinctUntilChanged()),
      refreshTrigger$,
    ]).pipe(
      switchMap(([txid]) =>
        combineLatest([
          this.apiService.getCoreTipHeight$(),
          this.apiService.getCoreTransaction$(txid),
        ]).pipe(
          map(([coreTipHeight, tx]) => {
            const status = tx?.status || tx;
            return {
              found: true as const,
              confirmations: (status?.confirmed && status?.block_height != null)
                ? Math.max(1, coreTipHeight - status.block_height + 1)
                : 0,
            };
          }),
          catchError((err) => {
            if (err?.status === 404) {
              return of({ found: false as const, confirmations: 0 });
            }
            // Unexpected error (network/CORS/timeout): hide badge.
            return of(null);
          }),
        )
      ),
    ).subscribe((result) => {
      if (!result) {
        this.loaded = false;
        this.found = false;
        this.confirmations = 0;
      } else {
        this.loaded = true;
        this.found = result.found;
        this.confirmations = result.confirmations;
      }
      this.ref.markForCheck();
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.txid) {
      this.loaded = false;
      this.txid$.next(this.txid || null);
    }
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }

  get buttonColorClass(): string {
    if (!this.found) {
      return 'btn-danger';
    }
    if (this.confirmations >= 6) {
      return 'btn-success';
    }
    if (this.confirmations >= 1) {
      return 'btn-primary';
    }
    return 'btn-warning';
  }
}
