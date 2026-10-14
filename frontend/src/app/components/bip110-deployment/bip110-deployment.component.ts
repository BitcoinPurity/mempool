import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { StateService } from '@app/services/state.service';
import { PurityReducedDataStatus } from '@interfaces/node-api.interface';

@Component({
  selector: 'app-bip110-deployment',
  templateUrl: './bip110-deployment.component.html',
  styleUrls: ['./bip110-deployment.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class Bip110DeploymentComponent implements OnInit {
  status$: Observable<PurityReducedDataStatus>;
  isLoading$: Observable<boolean>;
  bip110ScanProgress$: Observable<number>;

  constructor(
    private stateService: StateService,
  ) {}

  ngOnInit(): void {
    this.status$ = this.stateService.purityReducedData$;
    this.isLoading$ = this.stateService.isLoadingWebSocket$;
    this.bip110ScanProgress$ = this.stateService.loadingIndicators$.pipe(
      map(indicators => indicators['bip110-scan'] !== undefined ? indicators['bip110-scan'] : -1)
    );
  }
}
