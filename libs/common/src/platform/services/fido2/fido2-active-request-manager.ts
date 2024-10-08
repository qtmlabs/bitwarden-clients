import {
  BehaviorSubject,
  distinctUntilChanged,
  firstValueFrom,
  map,
  Observable,
  shareReplay,
  startWith,
  Subject,
} from "rxjs";

import { Fido2CredentialView } from "../../../vault/models/view/fido2-credential.view";
import {
  ActiveRequest,
  RequestCollection,
  Fido2ActiveRequestManager as Fido2ActiveRequestManagerAbstraction,
  Fido2ActiveRequestEvents,
  RequestResult,
} from "../../abstractions/fido2/fido2-active-request-manager.abstraction";

export class Fido2ActiveRequestManager implements Fido2ActiveRequestManagerAbstraction {
  private activeRequests$: BehaviorSubject<RequestCollection> = new BehaviorSubject({});

  /**
   * Gets the observable stream of all active requests associated with a given tab id.
   *
   * @param tabId - The tab id to get the active request for.
   */
  getActiveRequest$(tabId: number): Observable<ActiveRequest | undefined> {
    return this.activeRequests$.pipe(
      map((requests) => requests[tabId]),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true }),
      startWith(undefined),
    );
  }

  /**
   * Gets the active request associated with a given tab id.
   *
   * @param tabId - The tab id to get the active request for.
   */
  getActiveRequest(tabId: number): ActiveRequest | undefined {
    return this.activeRequests$.value[tabId];
  }

  private newInitialRequestSubject: Subject<void> = new Subject<void>();

  /**
   * Triggered on new WebAuthn Conditional UI requests from applications.
   */
  newInitialRequest$: Observable<void> = this.newInitialRequestSubject;

  /**
   * Creates a new active fido2 request.
   *
   * @param tabId - The tab id to associate the request with.
   * @param credentials - The credentials to use for the request.
   * @param fallbackSupported - Whether the browser supports native WebAuthn.
   * @param isInitialRequest - Whether this is not a retried request.
   * @param abortController - The abort controller to use for the request.
   */
  async newActiveRequest(
    tabId: number,
    credentials: Fido2CredentialView[],
    fallbackSupported: boolean,
    isInitialRequest: boolean,
    abortController: AbortController,
  ): Promise<RequestResult> {
    const newRequest: ActiveRequest = {
      credentials,
      fallbackSupported,
      subject: new Subject(),
    };
    this.updateRequests((existingRequests) => ({
      ...existingRequests,
      [tabId]: newRequest,
    }));

    if (isInitialRequest) {
      this.newInitialRequestSubject.next();
    }

    const abortListener = () => this.abortActiveRequest(tabId, false);
    abortController.signal.addEventListener("abort", abortListener);
    const requestResult = await firstValueFrom(newRequest.subject);
    abortController.signal.removeEventListener("abort", abortListener);

    this.removeActiveRequest(tabId);

    return requestResult;
  }

  /**
   * Removes and aborts the active request associated with a given tab id.
   *
   * @param tabId - The tab id to abort the active request for.
   * @param fallbackRequested - Whether the user requested a fallback to native passkeys.
   */
  removeActiveRequest(tabId: number, fallbackRequested = false) {
    this.abortActiveRequest(tabId, fallbackRequested);
    this.updateRequests((existingRequests) => {
      const newRequests = { ...existingRequests };
      delete newRequests[tabId];
      return newRequests;
    });
  }

  /**
   * Removes and aborts all active requests.
   */
  removeAllActiveRequests() {
    Object.keys(this.activeRequests$.value).forEach((tabId) => {
      this.abortActiveRequest(Number(tabId), false);
    });
    this.updateRequests(() => ({}));
  }

  /**
   * Aborts the active request associated with a given tab id.
   *
   * @param tabId - The tab id to abort the active request for.
   */
  private abortActiveRequest(tabId: number, fallbackRequested: boolean): void {
    this.activeRequests$.value[tabId]?.subject.next({
      type: Fido2ActiveRequestEvents.Abort,
      fallbackRequested,
    });
    this.activeRequests$.value[tabId]?.subject.error(
      new DOMException("The operation either timed out or was not allowed.", "AbortError"),
    );
  }

  /**
   * Updates the active requests.
   *
   * @param updateFunction - The function to use to update the active requests.
   */
  private updateRequests(
    updateFunction: (existingRequests: RequestCollection) => RequestCollection,
  ) {
    this.activeRequests$.next(updateFunction(this.activeRequests$.value));
  }
}
