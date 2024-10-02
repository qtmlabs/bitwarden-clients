import "@webcomponents/custom-elements";
import "lit/polyfill-support.js";
import { FocusableElement, tabbable } from "tabbable";

import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import {
  EVENTS,
  AutofillOverlayVisibility,
  AUTOFILL_OVERLAY_HANDLE_REPOSITION,
  AUTOFILL_TRIGGER_FORM_FIELD_SUBMIT,
} from "@bitwarden/common/autofill/constants";
import { CipherType } from "@bitwarden/common/vault/enums";

import {
  FocusedFieldData,
  NewCardCipherData,
  NewIdentityCipherData,
  NewLoginCipherData,
  SubFrameOffsetData,
} from "../background/abstractions/overlay.background";
import { AutofillExtensionMessage } from "../content/abstractions/autofill-init";
import { AutofillFieldQualifier, AutofillFieldQualifierType } from "../enums/autofill-field.enums";
import {
  AutofillOverlayElement,
  MAX_SUB_FRAME_DEPTH,
  RedirectFocusDirection,
} from "../enums/autofill-overlay.enum";
import AutofillField from "../models/autofill-field";
import AutofillPageDetails from "../models/autofill-page-details";
import { ElementWithOpId, FillableFormFieldElement, FormFieldElement } from "../types";
import {
  elementIsFillableFormField,
  elementIsSelectElement,
  getAttributeBoolean,
  nodeIsButtonElement,
  nodeIsTypeSubmitElement,
  sendExtensionMessage,
  throttle,
} from "../utils";

import {
  AutofillOverlayContentExtensionMessageHandlers,
  AutofillOverlayContentService as AutofillOverlayContentServiceInterface,
  NotificationFormFieldData,
  OpenAutofillInlineMenuOptions,
  SubFrameDataFromWindowMessage,
} from "./abstractions/autofill-overlay-content.service";
import { DomQueryService } from "./abstractions/dom-query.service";
import { InlineMenuFieldQualificationService } from "./abstractions/inline-menu-field-qualifications.service";
import { AutoFillConstants } from "./autofill-constants";

export class AutofillOverlayContentService implements AutofillOverlayContentServiceInterface {
  pageDetailsUpdateRequired = false;
  inlineMenuVisibility: number;
  private readonly findTabs = tabbable;
  private readonly sendExtensionMessage = sendExtensionMessage;
  private formFieldElements: Map<ElementWithOpId<FormFieldElement>, AutofillField> = new Map();
  private hiddenFormFieldElements: WeakMap<ElementWithOpId<FormFieldElement>, AutofillField> =
    new WeakMap();
  private formElements: Set<HTMLFormElement> = new Set();
  private submitElements: Set<HTMLElement> = new Set();
  private fieldsWithSubmitElements: WeakMap<FillableFormFieldElement, HTMLElement> = new WeakMap();
  private ignoredFieldTypes: Set<string> = new Set(AutoFillConstants.ExcludedInlineMenuTypes);
  private userFilledFields: Record<string, FillableFormFieldElement> = {};
  private authStatus: AuthenticationStatus;
  private focusableElements: FocusableElement[] = [];
  private mostRecentlyFocusedField: ElementWithOpId<FormFieldElement>;
  private focusedFieldData: FocusedFieldData;
  private closeInlineMenuOnRedirectTimeout: number | NodeJS.Timeout;
  private focusInlineMenuListTimeout: number | NodeJS.Timeout;
  private eventHandlersMemo: { [key: string]: EventListener } = {};
  private readonly extensionMessageHandlers: AutofillOverlayContentExtensionMessageHandlers = {
    openAutofillInlineMenu: ({ message }) => this.openInlineMenu(message),
    addNewVaultItemFromOverlay: ({ message }) => this.addNewVaultItem(message),
    blurMostRecentlyFocusedField: () => this.blurMostRecentlyFocusedField(),
    unsetMostRecentlyFocusedField: () => this.unsetMostRecentlyFocusedField(),
    checkIsMostRecentlyFocusedFieldWithinViewport: () =>
      this.checkIsMostRecentlyFocusedFieldWithinViewport(),
    bgUnlockPopoutOpened: () => this.blurMostRecentlyFocusedField(true),
    bgVaultItemRepromptPopoutOpened: () => this.blurMostRecentlyFocusedField(true),
    redirectAutofillInlineMenuFocusOut: ({ message }) =>
      this.redirectInlineMenuFocusOut(message?.data?.direction),
    updateAutofillInlineMenuVisibility: ({ message }) => this.updateInlineMenuVisibility(message),
    getSubFrameOffsets: ({ message }) => this.getSubFrameOffsets(message),
    getSubFrameOffsetsFromWindowMessage: ({ message }) =>
      this.getSubFrameOffsetsFromWindowMessage(message),
    checkMostRecentlyFocusedFieldHasValue: () => this.mostRecentlyFocusedFieldHasValue(),
    setupRebuildSubFrameOffsetsListeners: () => this.setupRebuildSubFrameOffsetsListeners(),
    destroyAutofillInlineMenuListeners: () => this.destroy(),
    getFormFieldDataForNotification: () => this.handleGetFormFieldDataForNotificationMessage(),
  };
  private readonly loginFieldQualifiers: Record<string, CallableFunction> = {
    [AutofillFieldQualifier.username]: this.inlineMenuFieldQualificationService.isUsernameField,
    [AutofillFieldQualifier.password]:
      this.inlineMenuFieldQualificationService.isCurrentPasswordField,
  };
  private readonly cardFieldQualifiers: Record<string, CallableFunction> = {
    [AutofillFieldQualifier.cardholderName]:
      this.inlineMenuFieldQualificationService.isFieldForCardholderName,
    [AutofillFieldQualifier.cardNumber]:
      this.inlineMenuFieldQualificationService.isFieldForCardNumber,
    [AutofillFieldQualifier.cardExpirationMonth]:
      this.inlineMenuFieldQualificationService.isFieldForCardExpirationMonth,
    [AutofillFieldQualifier.cardExpirationYear]:
      this.inlineMenuFieldQualificationService.isFieldForCardExpirationYear,
    [AutofillFieldQualifier.cardExpirationDate]:
      this.inlineMenuFieldQualificationService.isFieldForCardExpirationDate,
    [AutofillFieldQualifier.cardCvv]: this.inlineMenuFieldQualificationService.isFieldForCardCvv,
  };
  private readonly identityFieldQualifiers: Record<string, CallableFunction> = {
    [AutofillFieldQualifier.identityTitle]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityTitle,
    [AutofillFieldQualifier.identityFirstName]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityFirstName,
    [AutofillFieldQualifier.identityMiddleName]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityMiddleName,
    [AutofillFieldQualifier.identityLastName]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityLastName,
    [AutofillFieldQualifier.identityFullName]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityFullName,
    [AutofillFieldQualifier.identityAddress1]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityAddress1,
    [AutofillFieldQualifier.identityAddress2]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityAddress2,
    [AutofillFieldQualifier.identityAddress3]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityAddress3,
    [AutofillFieldQualifier.identityCity]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityCity,
    [AutofillFieldQualifier.identityState]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityState,
    [AutofillFieldQualifier.identityPostalCode]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityPostalCode,
    [AutofillFieldQualifier.identityCountry]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityCountry,
    [AutofillFieldQualifier.identityCompany]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityCompany,
    [AutofillFieldQualifier.identityPhone]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityPhone,
    [AutofillFieldQualifier.identityEmail]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityEmail,
    [AutofillFieldQualifier.identityUsername]:
      this.inlineMenuFieldQualificationService.isFieldForIdentityUsername,
    [AutofillFieldQualifier.newPassword]:
      this.inlineMenuFieldQualificationService.isNewPasswordField,
  };

  constructor(
    private domQueryService: DomQueryService,
    private inlineMenuFieldQualificationService: InlineMenuFieldQualificationService,
  ) {}

  /**
   * Initializes the autofill overlay content service by setting up the mutation observers.
   * The observers will be instantiated on DOMContentLoaded if the page is current loading.
   */
  init() {
    if (globalThis.document.readyState === "loading") {
      globalThis.document.addEventListener(EVENTS.DOMCONTENTLOADED, this.setupGlobalEventListeners);
      return;
    }

    this.setupGlobalEventListeners();
  }

  /**
   * Getter used to access the extension message handlers associated
   * with the autofill overlay content service.
   */
  get messageHandlers(): AutofillOverlayContentExtensionMessageHandlers {
    return this.extensionMessageHandlers;
  }

  /**
   * Sets up the autofill inline menu listener on the form field element. This method is called
   * during the page details collection process.
   *
   * @param formFieldElement - Form field elements identified during the page details collection process.
   * @param autofillFieldData - Autofill field data captured from the form field element.
   * @param pageDetails - The collected page details from the tab.
   */
  async setupOverlayListeners(
    formFieldElement: ElementWithOpId<FormFieldElement>,
    autofillFieldData: AutofillField,
    pageDetails: AutofillPageDetails,
  ) {
    if (
      this.formFieldElements.has(formFieldElement) ||
      this.isIgnoredField(autofillFieldData, pageDetails)
    ) {
      return;
    }

    if (this.isHiddenField(formFieldElement, autofillFieldData)) {
      return;
    }

    await this.setupOverlayListenersOnQualifiedField(formFieldElement, autofillFieldData);
  }

  /**
   * Handles opening the autofill inline menu. Will conditionally open
   * the inline menu based on the current inline menu visibility setting.
   * Allows you to optionally focus the field element when opening the inline menu.
   * Will also optionally ignore the inline menu visibility setting and open the
   *
   * @param options - Options for opening the autofill inline menu.
   */
  openInlineMenu(options: OpenAutofillInlineMenuOptions = {}) {
    const { isFocusingFieldElement, isOpeningFullInlineMenu, authStatus } = options;
    if (!this.mostRecentlyFocusedField) {
      return;
    }

    if (this.pageDetailsUpdateRequired) {
      void this.sendExtensionMessage("bgCollectPageDetails", {
        sender: "autofillOverlayContentService",
      });
      this.pageDetailsUpdateRequired = false;
    }

    if (isFocusingFieldElement && !this.recentlyFocusedFieldIsCurrentlyFocused()) {
      this.focusMostRecentlyFocusedField();
    }

    if (typeof authStatus !== "undefined") {
      this.authStatus = authStatus;
    }

    if (
      this.inlineMenuVisibility === AutofillOverlayVisibility.OnButtonClick &&
      !isOpeningFullInlineMenu
    ) {
      this.updateInlineMenuButtonPosition();
      return;
    }

    this.updateInlineMenuElementsPosition();
  }

  /**
   * Focuses the most recently focused field element.
   */
  focusMostRecentlyFocusedField() {
    this.mostRecentlyFocusedField?.focus();
  }

  /**
   * Removes focus from the most recently focused field element.
   */
  blurMostRecentlyFocusedField(isClosingInlineMenu: boolean = false) {
    this.mostRecentlyFocusedField?.blur();

    if (isClosingInlineMenu) {
      void this.sendExtensionMessage("closeAutofillInlineMenu");
    }
  }

  /**
   * Sets the most recently focused field within the current frame to a `null` value.
   */
  unsetMostRecentlyFocusedField() {
    this.mostRecentlyFocusedField = null;
  }

  /**
   * Formats any found user filled fields for a login cipher and sends a message
   * to the background script to add a new cipher.
   */
  async addNewVaultItem({ addNewCipherType }: AutofillExtensionMessage) {
    const command = "autofillOverlayAddNewVaultItem";
    const password =
      this.userFilledFields["newPassword"]?.value || this.userFilledFields["password"]?.value;

    if (addNewCipherType === CipherType.Login) {
      const login: NewLoginCipherData = {
        username: this.userFilledFields["username"]?.value || "",
        password: password || "",
        uri: globalThis.document.URL,
        hostname: globalThis.document.location.hostname,
      };

      void this.sendExtensionMessage(command, { addNewCipherType, login });

      return;
    }

    if (addNewCipherType === CipherType.Card) {
      const card: NewCardCipherData = {
        cardholderName: this.userFilledFields["cardholderName"]?.value || "",
        number: this.userFilledFields["cardNumber"]?.value || "",
        expirationMonth: this.userFilledFields["cardExpirationMonth"]?.value || "",
        expirationYear: this.userFilledFields["cardExpirationYear"]?.value || "",
        expirationDate: this.userFilledFields["cardExpirationDate"]?.value || "",
        cvv: this.userFilledFields["cardCvv"]?.value || "",
      };

      void this.sendExtensionMessage(command, { addNewCipherType, card });

      return;
    }

    if (addNewCipherType === CipherType.Identity) {
      const identity: NewIdentityCipherData = {
        title: this.userFilledFields["identityTitle"]?.value || "",
        firstName: this.userFilledFields["identityFirstName"]?.value || "",
        middleName: this.userFilledFields["identityMiddleName"]?.value || "",
        lastName: this.userFilledFields["identityLastName"]?.value || "",
        fullName: this.userFilledFields["identityFullName"]?.value || "",
        address1: this.userFilledFields["identityAddress1"]?.value || "",
        address2: this.userFilledFields["identityAddress2"]?.value || "",
        address3: this.userFilledFields["identityAddress3"]?.value || "",
        city: this.userFilledFields["identityCity"]?.value || "",
        state: this.userFilledFields["identityState"]?.value || "",
        postalCode: this.userFilledFields["identityPostalCode"]?.value || "",
        country: this.userFilledFields["identityCountry"]?.value || "",
        company: this.userFilledFields["identityCompany"]?.value || "",
        phone: this.userFilledFields["identityPhone"]?.value || "",
        email: this.userFilledFields["identityEmail"]?.value || "",
        username: this.userFilledFields["identityUsername"]?.value || "",
      };

      void this.sendExtensionMessage(command, { addNewCipherType, identity });
    }
  }

  /**
   * Redirects the keyboard focus out of the inline menu, selecting the element that is
   * either previous or next in the tab order. If the direction is current, the most
   * recently focused field will be focused.
   *
   * @param direction - The direction to redirect the focus out.
   */
  private async redirectInlineMenuFocusOut(direction?: string) {
    if (!direction || !this.mostRecentlyFocusedField || !(await this.isInlineMenuListVisible())) {
      return;
    }

    if (direction === RedirectFocusDirection.Current) {
      this.focusMostRecentlyFocusedField();
      this.closeInlineMenuOnRedirectTimeout = globalThis.setTimeout(
        () => void this.sendExtensionMessage("closeAutofillInlineMenu"),
        100,
      );
      return;
    }

    if (!this.focusableElements.length) {
      this.focusableElements = this.findTabs(globalThis.document.body, { getShadowRoot: true });
    }

    const focusedElementIndex = this.focusableElements.findIndex(
      (element) => element === this.mostRecentlyFocusedField,
    );

    const indexOffset = direction === RedirectFocusDirection.Previous ? -1 : 1;
    const redirectFocusElement = this.focusableElements[focusedElementIndex + indexOffset];
    if (redirectFocusElement) {
      redirectFocusElement.focus();
      return;
    }

    this.focusMostRecentlyFocusedField();
  }

  /**
   * Sets up the event listeners that facilitate interaction with the form field elements.
   * Will clear any cached form field element handlers that are encountered when setting
   * up a form field element.
   *
   * @param formFieldElement - The form field element to set up the event listeners for.
   */
  private setupFormFieldElementEventListeners(formFieldElement: ElementWithOpId<FormFieldElement>) {
    this.removeCachedFormFieldEventListeners(formFieldElement);

    formFieldElement.addEventListener(
      EVENTS.INPUT,
      this.handleFormFieldInputEvent(formFieldElement),
    );
    formFieldElement.addEventListener(
      EVENTS.FOCUS,
      this.handleFormFieldFocusEvent(formFieldElement),
    );

    if (elementIsSelectElement(formFieldElement)) {
      return;
    }

    formFieldElement.addEventListener(EVENTS.BLUR, this.handleFormFieldBlurEvent);
    formFieldElement.addEventListener(EVENTS.KEYUP, this.handleFormFieldKeyupEvent);
    formFieldElement.addEventListener(
      EVENTS.CLICK,
      this.handleFormFieldClickEvent(formFieldElement),
    );
  }

  /**
   * Removes any cached form field element handlers that are encountered
   * when setting up a form field element to present the inline menu.
   *
   * @param formFieldElement - The form field element to remove the cached handlers for.
   */
  private removeCachedFormFieldEventListeners(formFieldElement: ElementWithOpId<FormFieldElement>) {
    const handlers = [EVENTS.INPUT, EVENTS.CLICK, EVENTS.FOCUS];
    for (let index = 0; index < handlers.length; index++) {
      const event = handlers[index];
      const memoIndex = this.getFormFieldHandlerMemoIndex(formFieldElement, event);
      const existingHandler = this.eventHandlersMemo[memoIndex];
      if (!existingHandler) {
        return;
      }

      formFieldElement.removeEventListener(event, existingHandler);
      delete this.eventHandlersMemo[memoIndex];
    }
  }

  /**
   * Sets up listeners on the submit button that triggers a submission of the field's form.
   *
   * @param formFieldElement - The form field element to set up the submit button listeners for.
   * @param autofillFieldData - Autofill field data captured from the form field element.
   */
  private setupFormSubmissionEventListeners(
    formFieldElement: ElementWithOpId<FormFieldElement>,
    autofillFieldData: AutofillField,
  ) {
    if (
      !elementIsFillableFormField(formFieldElement) ||
      autofillFieldData.filledByCipherType === CipherType.Card
    ) {
      return;
    }

    if (autofillFieldData.form) {
      this.setupSubmitListenerOnFieldWithForms(formFieldElement);
      return;
    }

    this.setupSubmitListenerOnFormlessField(formFieldElement);
  }

  /**
   * Sets up the submit listener on the form field element that contains a form element.
   * Will establish on submit event listeners on the form element and click listeners on
   * the submit button element that triggers the submission of the form.
   *
   * @param formFieldElement - The form field element to set up the submit listener for.
   */
  private setupSubmitListenerOnFieldWithForms(formFieldElement: FillableFormFieldElement) {
    const formElement = formFieldElement.form;
    if (formElement && !this.formElements.has(formElement)) {
      this.formElements.add(formElement);
      formElement.addEventListener(EVENTS.SUBMIT, this.handleFormFieldSubmitEvent);

      const closesSubmitButton = this.findSubmitButton(formElement);
      this.setupSubmitButtonEventListeners(closesSubmitButton);
    }
  }

  /**
   * Sets up the submit listener on the form field element that does not contain a form element.
   * Will establish a submit button event listener on the closest formless submit button element.
   *
   * @param formFieldElement - The form field element to set up the submit listener for.
   */
  private setupSubmitListenerOnFormlessField(formFieldElement: FillableFormFieldElement) {
    if (formFieldElement && !this.fieldsWithSubmitElements.has(formFieldElement)) {
      const closesSubmitButton = this.findClosestFormlessSubmitButton(formFieldElement);
      this.setupSubmitButtonEventListeners(closesSubmitButton);
    }
  }

  /**
   * Finds the closest formless submit button element to the form field element.
   *
   * @param formFieldElement - The form field element to find the closest formless submit button for.
   */
  private findClosestFormlessSubmitButton(
    formFieldElement: FillableFormFieldElement,
  ): HTMLElement | null {
    let currentElement: HTMLElement = formFieldElement;

    while (currentElement && currentElement.tagName !== "HTML") {
      const submitButton = this.findSubmitButton(currentElement);
      if (submitButton) {
        this.formFieldElements.forEach((_, element) => {
          if (currentElement.contains(element)) {
            this.fieldsWithSubmitElements.set(element as FillableFormFieldElement, submitButton);
          }
        });

        return submitButton;
      }

      if (!currentElement.parentElement && currentElement.getRootNode() instanceof ShadowRoot) {
        currentElement = (currentElement.getRootNode() as ShadowRoot).host as any;
        continue;
      }

      currentElement = currentElement.parentElement;
    }

    return null;
  }

  /**
   * Finds the submit button element within the provided element. Will attempt to find a generic
   * submit element before attempting to find a button or button-like element.
   *
   * @param element - The element to find the submit button within.
   */
  private findSubmitButton(element: HTMLElement): HTMLElement | null {
    const genericSubmitElement = this.querySubmitButtonElement(
      element,
      "[type='submit']",
      (node: Node) => nodeIsTypeSubmitElement(node),
    );
    if (genericSubmitElement) {
      return genericSubmitElement;
    }

    const submitButtonElement = this.querySubmitButtonElement(
      element,
      "button, [type='button']",
      (node: Node) => nodeIsButtonElement(node),
    );
    if (submitButtonElement) {
      return submitButtonElement;
    }
  }

  /**
   * Queries the provided element for a submit button element using the provided selector.
   *
   * @param element - The element to query for a submit button.
   * @param selector - The selector to use to query the element for a submit button.
   * @param treeWalkerFilter - The tree walker filter to use when querying the element.
   */
  private querySubmitButtonElement(
    element: HTMLElement,
    selector: string,
    treeWalkerFilter: CallableFunction,
  ) {
    const submitButtonElements = this.domQueryService.query<HTMLButtonElement>(
      element,
      selector,
      treeWalkerFilter,
    );
    for (let index = 0; index < submitButtonElements.length; index++) {
      const submitElement = submitButtonElements[index];
      if (this.isElementSubmitButton(submitElement)) {
        return submitElement;
      }
    }
  }

  /**
   * Determines if the provided element is a submit button element.
   *
   * @param element - The element to determine if it is a submit button.
   */
  private isElementSubmitButton(element: HTMLElement) {
    return (
      this.inlineMenuFieldQualificationService.isElementLoginSubmitButton(element) ||
      this.inlineMenuFieldQualificationService.isElementChangePasswordSubmitButton(element)
    );
  }

  /**
   * Sets up the event listeners that trigger an indication that a form has been submitted.
   *
   * @param submitButton - The submit button element to set up the event listeners for.
   */
  private setupSubmitButtonEventListeners = (submitButton: HTMLElement) => {
    if (!submitButton || this.submitElements.has(submitButton)) {
      return;
    }

    this.submitElements.add(submitButton);

    const handler = this.useEventHandlersMemo(
      throttle(this.handleSubmitButtonInteraction, 150),
      AUTOFILL_TRIGGER_FORM_FIELD_SUBMIT,
    );
    submitButton.addEventListener(EVENTS.KEYUP, handler);
    globalThis.document.addEventListener(EVENTS.CLICK, handler);
    globalThis.document.addEventListener(EVENTS.MOUSEUP, handler);
  };

  /**
   * Handles click and keyup events that trigger behavior for a submit button element.
   *
   * @param event - The event that triggered the submit button interaction.
   */
  private handleSubmitButtonInteraction = (event: PointerEvent) => {
    if (
      !this.submitElements.has(event.target as HTMLElement) ||
      (event.type === "keyup" &&
        !["Enter", "Space"].includes((event as unknown as KeyboardEvent).code))
    ) {
      return;
    }

    this.handleFormFieldSubmitEvent();
  };

  /**
   * Handles the repositioning of the autofill overlay when the form is submitted.
   */
  private handleFormFieldSubmitEvent = () => {
    void this.sendExtensionMessage("formFieldSubmitted", this.getFormFieldDataForNotification());
  };

  /**
   * Handles capturing the form field data for a notification message. Is triggered from the
   * background script when a POST request is encountered. Will not trigger this behavior
   * in the case where the user is still typing in the field.
   */
  private handleGetFormFieldDataForNotificationMessage = async () => {
    if (await this.isFieldCurrentlyFocused()) {
      return;
    }

    return this.getFormFieldDataForNotification();
  };

  /**
   * Returns the form field data used for add login and change password notifications.
   */
  private getFormFieldDataForNotification = (): NotificationFormFieldData => {
    return {
      uri: globalThis.document.URL,
      username: this.userFilledFields["username"]?.value || "",
      password: this.userFilledFields["password"]?.value || "",
      newPassword: this.userFilledFields["newPassword"]?.value || "",
    };
  };

  /**
   * Helper method that facilitates registration of an event handler to a form field element.
   *
   * @param eventHandler - The event handler to memoize.
   * @param memoIndex - The memo index to use for the event handler.
   */
  private useEventHandlersMemo = (eventHandler: EventListener, memoIndex: string) => {
    return this.eventHandlersMemo[memoIndex] || (this.eventHandlersMemo[memoIndex] = eventHandler);
  };

  /**
   * Formats the memoIndex for the form field event handler.
   *
   * @param formFieldElement - The form field element to format the memo index for.
   * @param event - The event to format the memo index for.
   */
  private getFormFieldHandlerMemoIndex(
    formFieldElement: ElementWithOpId<FormFieldElement>,
    event: string,
  ) {
    return `${formFieldElement.opid}-${formFieldElement.id}-${event}-handler`;
  }

  /**
   * Form Field blur event handler. Updates the value identifying whether
   * the field is focused and sends a message to check if the inline menu itself
   * is currently focused.
   */
  private handleFormFieldBlurEvent = () => {
    void this.sendExtensionMessage("updateIsFieldCurrentlyFocused", {
      isFieldCurrentlyFocused: false,
    });
    void this.sendExtensionMessage("checkAutofillInlineMenuFocused");
  };

  /**
   * Form field keyup event handler. Facilitates the ability to remove the
   * autofill inline menu using the escape key, focusing the inline menu list using
   * the ArrowDown key, and ensuring that the inline menu is repositioned when
   * the form is submitted using the Enter key.
   *
   * @param event - The keyup event.
   */
  private handleFormFieldKeyupEvent = async (event: globalThis.KeyboardEvent) => {
    const eventCode = event.code;
    if (eventCode === "Escape") {
      void this.sendExtensionMessage("closeAutofillInlineMenu", {
        forceCloseInlineMenu: true,
      });
      return;
    }

    if (eventCode === "Enter" && !(await this.isFieldCurrentlyFilling())) {
      void this.handleOverlayRepositionEvent();
      return;
    }

    if (eventCode === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();

      void this.focusInlineMenuList();
    }
  };

  /**
   * Triggers a focus of the inline menu list, if it is visible. If the list is not visible,
   * the inline menu will be opened and the list will be focused after a short delay. Ensures
   * that the inline menu list is focused when the user presses the down arrow key.
   */
  private async focusInlineMenuList() {
    if (this.mostRecentlyFocusedField && !(await this.isInlineMenuListVisible())) {
      this.clearFocusInlineMenuListTimeout();
      await this.updateMostRecentlyFocusedField(this.mostRecentlyFocusedField);
      this.openInlineMenu({ isOpeningFullInlineMenu: true });
      this.focusInlineMenuListTimeout = globalThis.setTimeout(
        () => this.sendExtensionMessage("focusAutofillInlineMenuList"),
        125,
      );
      return;
    }

    void this.sendExtensionMessage("focusAutofillInlineMenuList");
  }

  /**
   * Sets up and memoizes the form field input event handler.
   *
   * @param formFieldElement - The form field element that triggered the input event.
   */
  private handleFormFieldInputEvent = (formFieldElement: ElementWithOpId<FormFieldElement>) => {
    return this.useEventHandlersMemo(
      () => this.triggerFormFieldInput(formFieldElement),
      this.getFormFieldHandlerMemoIndex(formFieldElement, EVENTS.INPUT),
    );
  };

  /**
   * Triggers when the form field element receives an input event. This method will
   * store the modified form element data for use when the user attempts to add a new
   * vault item. It also acts to remove the inline menu list while the user is typing.
   *
   * @param formFieldElement - The form field element that triggered the input event.
   */
  private async triggerFormFieldInput(formFieldElement: ElementWithOpId<FormFieldElement>) {
    if (!elementIsFillableFormField(formFieldElement)) {
      return;
    }

    this.storeModifiedFormElement(formFieldElement);
    if (elementIsSelectElement(formFieldElement)) {
      return;
    }

    if (await this.hideInlineMenuListOnFilledField(formFieldElement)) {
      void this.sendExtensionMessage("closeAutofillInlineMenu", {
        overlayElement: AutofillOverlayElement.List,
        forceCloseInlineMenu: true,
      });
      return;
    }

    this.openInlineMenu();
  }

  /**
   * Stores the modified form element data for use when the user attempts to add a new
   * vault item. This method will also store the most recently focused field, if it is
   * not already stored.
   *
   * @param formFieldElement
   * @private
   */
  private storeModifiedFormElement(formFieldElement: ElementWithOpId<FillableFormFieldElement>) {
    if (formFieldElement !== this.mostRecentlyFocusedField) {
      void this.updateMostRecentlyFocusedField(formFieldElement);
    }

    const autofillFieldData = this.formFieldElements.get(formFieldElement);
    if (!autofillFieldData) {
      return;
    }

    if (!autofillFieldData.fieldQualifier) {
      switch (autofillFieldData.filledByCipherType) {
        case CipherType.Login:
          this.qualifyUserFilledLoginField(autofillFieldData);
          break;
        case CipherType.Card:
          this.qualifyUserFilledCardField(autofillFieldData);
          break;
        case CipherType.Identity:
          this.qualifyUserFilledIdentityField(autofillFieldData);
          break;
      }
    }

    this.storeQualifiedUserFilledField(formFieldElement, autofillFieldData);
  }

  /**
   * Handles qualifying the user field login field to be used when adding a new vault item.
   *
   * @param autofillFieldData - Autofill field data captured from the form field element.
   */
  private qualifyUserFilledLoginField(autofillFieldData: AutofillField) {
    for (const [fieldQualifier, fieldQualifierFunction] of Object.entries(
      this.loginFieldQualifiers,
    )) {
      if (fieldQualifierFunction(autofillFieldData)) {
        autofillFieldData.fieldQualifier = fieldQualifier as AutofillFieldQualifierType;
        return;
      }
    }
  }

  /**
   * Handles qualifying the user field card field to be used when adding a new vault item.
   *
   * @param autofillFieldData - Autofill field data captured from the form field element.
   */
  private qualifyUserFilledCardField(autofillFieldData: AutofillField) {
    for (const [fieldQualifier, fieldQualifierFunction] of Object.entries(
      this.cardFieldQualifiers,
    )) {
      if (fieldQualifierFunction(autofillFieldData)) {
        autofillFieldData.fieldQualifier = fieldQualifier as AutofillFieldQualifierType;
        return;
      }
    }
  }

  /**
   *  Handles qualifying the user field identity field to be used when adding a new vault item.
   *
   * @param autofillFieldData - Autofill field data captured from the form field element.
   */
  private qualifyUserFilledIdentityField(autofillFieldData: AutofillField) {
    for (const [fieldQualifier, fieldQualifierFunction] of Object.entries(
      this.identityFieldQualifiers,
    )) {
      if (fieldQualifierFunction(autofillFieldData)) {
        autofillFieldData.fieldQualifier = fieldQualifier as AutofillFieldQualifierType;
        return;
      }
    }
  }

  /**
   * Stores the qualified user filled filed to allow for referencing its value when adding a new vault item.
   *
   * @param formFieldElement - The form field element that triggered the input event.
   * @param autofillFieldData - Autofill field data captured from the form field element.
   */
  private storeQualifiedUserFilledField(
    formFieldElement: ElementWithOpId<FillableFormFieldElement>,
    autofillFieldData: AutofillField,
  ) {
    if (!autofillFieldData.fieldQualifier) {
      return;
    }

    const clonedNode = formFieldElement.cloneNode() as FillableFormFieldElement;
    const identityLoginFields: AutofillFieldQualifierType[] = [
      AutofillFieldQualifier.identityUsername,
      AutofillFieldQualifier.identityEmail,
    ];
    if (identityLoginFields.includes(autofillFieldData.fieldQualifier)) {
      this.userFilledFields[AutofillFieldQualifier.username] = clonedNode;
    }

    this.userFilledFields[autofillFieldData.fieldQualifier] = clonedNode;
  }

  /**
   * Sets up and memoizes the form field click event handler.
   *
   * @param formFieldElement - The form field element that triggered the click event.
   */
  private handleFormFieldClickEvent = (formFieldElement: ElementWithOpId<FormFieldElement>) => {
    return this.useEventHandlersMemo(
      () => this.triggerFormFieldClickedAction(formFieldElement),
      this.getFormFieldHandlerMemoIndex(formFieldElement, EVENTS.CLICK),
    );
  };

  /**
   * Triggers when the form field element receives a click event. This method will
   * trigger the focused action for the form field element if the inline menu is not visible.
   *
   * @param formFieldElement - The form field element that triggered the click event.
   */
  private async triggerFormFieldClickedAction(formFieldElement: ElementWithOpId<FormFieldElement>) {
    if ((await this.isInlineMenuButtonVisible()) || (await this.isInlineMenuListVisible())) {
      return;
    }

    await this.triggerFormFieldFocusedAction(formFieldElement);
  }

  /**
   * Sets up and memoizes the form field focus event handler.
   *
   * @param formFieldElement - The form field element that triggered the focus event.
   */
  private handleFormFieldFocusEvent = (formFieldElement: ElementWithOpId<FormFieldElement>) => {
    return this.useEventHandlersMemo(
      () => this.triggerFormFieldFocusedAction(formFieldElement),
      this.getFormFieldHandlerMemoIndex(formFieldElement, EVENTS.FOCUS),
    );
  };

  /**
   * Triggers when the form field element receives a focus event. This method will
   * update the most recently focused field and open the autofill inline menu if the
   * autofill process is not currently active.
   *
   * @param formFieldElement - The form field element that triggered the focus event.
   */
  private async triggerFormFieldFocusedAction(formFieldElement: ElementWithOpId<FormFieldElement>) {
    if (await this.isFieldCurrentlyFilling()) {
      return;
    }

    if (elementIsSelectElement(formFieldElement)) {
      await this.sendExtensionMessage("closeAutofillInlineMenu", {
        forceCloseInlineMenu: true,
      });
      return;
    }

    await this.sendExtensionMessage("updateIsFieldCurrentlyFocused", {
      isFieldCurrentlyFocused: true,
    });
    const initiallyFocusedField = this.mostRecentlyFocusedField;
    await this.updateMostRecentlyFocusedField(formFieldElement);

    const hideInlineMenuListOnFilledField = await this.hideInlineMenuListOnFilledField(
      formFieldElement as FillableFormFieldElement,
    );
    if (
      this.inlineMenuVisibility === AutofillOverlayVisibility.OnButtonClick ||
      (initiallyFocusedField !== this.mostRecentlyFocusedField && hideInlineMenuListOnFilledField)
    ) {
      await this.sendExtensionMessage("closeAutofillInlineMenu", {
        overlayElement: AutofillOverlayElement.List,
        forceCloseInlineMenu: true,
      });
    }

    if (hideInlineMenuListOnFilledField) {
      this.updateInlineMenuButtonPosition();
      return;
    }

    void this.sendExtensionMessage("openAutofillInlineMenu");
  }

  /**
   * Validates whether the user is currently authenticated.
   */
  private isUserAuthed() {
    return this.authStatus === AuthenticationStatus.Unlocked;
  }

  /**
   * Validates that the most recently focused field is currently
   * focused within the root node relative to the field.
   */
  private recentlyFocusedFieldIsCurrentlyFocused() {
    return (
      this.getRootNodeActiveElement(this.mostRecentlyFocusedField) === this.mostRecentlyFocusedField
    );
  }

  /**
   * Updates the position of both the inline menu button and list.
   */
  private updateInlineMenuElementsPosition() {
    this.updateInlineMenuButtonPosition();
    this.updateInlineMenuListPosition();
  }

  /**
   * Updates the position of the inline menu button.
   */
  private updateInlineMenuButtonPosition() {
    void this.sendExtensionMessage("updateAutofillInlineMenuPosition", {
      overlayElement: AutofillOverlayElement.Button,
    });
  }

  /**
   * Updates the position of the inline menu list.
   */
  private updateInlineMenuListPosition() {
    void this.sendExtensionMessage("updateAutofillInlineMenuPosition", {
      overlayElement: AutofillOverlayElement.List,
    });
  }

  /**
   * Updates the data used to position the inline menu elements in relation
   * to the most recently focused form field.
   *
   * @param formFieldElement - The form field element that triggered the focus event.
   */
  private async updateMostRecentlyFocusedField(
    formFieldElement: ElementWithOpId<FormFieldElement>,
  ) {
    if (
      !formFieldElement ||
      !elementIsFillableFormField(formFieldElement) ||
      elementIsSelectElement(formFieldElement)
    ) {
      return;
    }

    this.mostRecentlyFocusedField = formFieldElement;
    const { paddingRight, paddingLeft } = globalThis.getComputedStyle(formFieldElement);
    const { width, height, top, left } =
      await this.getMostRecentlyFocusedFieldRects(formFieldElement);
    const autofillFieldData = this.formFieldElements.get(formFieldElement);
    let accountCreationFieldType = null;
    if (
      (autofillFieldData?.showInlineMenuAccountCreation ||
        autofillFieldData?.filledByCipherType === CipherType.Login) &&
      this.inlineMenuFieldQualificationService.isUsernameField(autofillFieldData)
    ) {
      accountCreationFieldType = this.inlineMenuFieldQualificationService.isEmailField(
        autofillFieldData,
      )
        ? "email"
        : autofillFieldData.type;
    }

    this.focusedFieldData = {
      focusedFieldStyles: { paddingRight, paddingLeft },
      focusedFieldRects: { width, height, top, left },
      filledByCipherType: autofillFieldData?.filledByCipherType,
      showInlineMenuAccountCreation: autofillFieldData?.showInlineMenuAccountCreation,
      showPasskeys: !!autofillFieldData?.autoCompleteType?.includes("webauthn"),
      accountCreationFieldType,
    };

    await this.sendExtensionMessage("updateFocusedFieldData", {
      focusedFieldData: this.focusedFieldData,
    });
  }

  /**
   * Gets the bounding client rects for the most recently focused field. This method will
   * attempt to use an intersection observer to get the most recently focused field's
   * bounding client rects. If the intersection observer is not supported, or the
   * intersection observer does not return a valid bounding client rect, the form
   * field element's bounding client rect will be used.
   *
   * @param formFieldElement - The form field element that triggered the focus event.
   */
  private async getMostRecentlyFocusedFieldRects(
    formFieldElement: ElementWithOpId<FormFieldElement>,
  ) {
    const focusedFieldRects =
      await this.getBoundingClientRectFromIntersectionObserver(formFieldElement);
    if (focusedFieldRects) {
      return focusedFieldRects;
    }

    return formFieldElement.getBoundingClientRect();
  }

  /**
   * Gets the bounds of the form field element from the IntersectionObserver API.
   *
   * @param formFieldElement - The form field element that triggered the focus event.
   */
  private async getBoundingClientRectFromIntersectionObserver(
    formFieldElement: ElementWithOpId<FormFieldElement>,
  ): Promise<DOMRectReadOnly | null> {
    if (!("IntersectionObserver" in globalThis) && !("IntersectionObserverEntry" in globalThis)) {
      return null;
    }

    return new Promise((resolve) => {
      const intersectionObserver = new IntersectionObserver(
        (entries) => {
          let fieldBoundingClientRects = entries[0]?.boundingClientRect;
          if (!fieldBoundingClientRects?.width || !fieldBoundingClientRects.height) {
            fieldBoundingClientRects = null;
          }

          intersectionObserver.disconnect();
          resolve(fieldBoundingClientRects);
        },
        {
          root: globalThis.document.body,
          rootMargin: "0px",
          threshold: 0.9999, // Safari doesn't seem to function properly with a threshold of 1
        },
      );
      intersectionObserver.observe(formFieldElement);
    });
  }

  /**
   * Identifies if the field should have the autofill inline menu setup on it. Currently, this is mainly
   * determined by whether the field correlates with a login cipher. This method will need to be
   * updated in the future to support other types of forms.
   *
   * @param autofillFieldData - Autofill field data captured from the form field element.
   * @param pageDetails - The collected page details from the tab.
   */
  private isIgnoredField(
    autofillFieldData: AutofillField,
    pageDetails: AutofillPageDetails,
  ): boolean {
    if (this.ignoredFieldTypes.has(autofillFieldData.type)) {
      return true;
    }

    if (
      this.inlineMenuFieldQualificationService.isFieldForLoginForm(autofillFieldData, pageDetails)
    ) {
      autofillFieldData.filledByCipherType = CipherType.Login;
      return false;
    }

    if (
      this.inlineMenuFieldQualificationService.isFieldForCreditCardForm(
        autofillFieldData,
        pageDetails,
      )
    ) {
      autofillFieldData.filledByCipherType = CipherType.Card;
      return false;
    }

    if (
      this.inlineMenuFieldQualificationService.isFieldForAccountCreationForm(
        autofillFieldData,
        pageDetails,
      )
    ) {
      autofillFieldData.filledByCipherType = CipherType.Identity;
      autofillFieldData.showInlineMenuAccountCreation = true;
      return false;
    }

    if (
      this.inlineMenuFieldQualificationService.isFieldForIdentityForm(
        autofillFieldData,
        pageDetails,
      )
    ) {
      autofillFieldData.filledByCipherType = CipherType.Identity;
      return false;
    }

    return true;
  }

  /**
   * Validates whether a field is considered to be "hidden" based on the field's attributes.
   * If the field is hidden, a fallback listener will be set up to ensure that the
   * field will have the inline menu set up on it when it becomes visible.
   *
   * @param formFieldElement - The form field element that triggered the focus event.
   * @param autofillFieldData - Autofill field data captured from the form field element.
   */
  private isHiddenField(
    formFieldElement: ElementWithOpId<FormFieldElement>,
    autofillFieldData: AutofillField,
  ): boolean {
    if (!autofillFieldData.readonly && !autofillFieldData.disabled && autofillFieldData.viewable) {
      this.removeHiddenFieldFallbackListener(formFieldElement);
      return false;
    }

    this.setupHiddenFieldFallbackListener(formFieldElement, autofillFieldData);
    return true;
  }

  /**
   * Sets up a fallback listener that will facilitate setting up the
   * inline menu on the field when it becomes visible and focused.
   *
   * @param formFieldElement - The form field element that triggered the focus event.
   * @param autofillFieldData - Autofill field data captured from the form field element.
   */
  private setupHiddenFieldFallbackListener(
    formFieldElement: ElementWithOpId<FormFieldElement>,
    autofillFieldData: AutofillField,
  ) {
    this.hiddenFormFieldElements.set(formFieldElement, autofillFieldData);
    formFieldElement.addEventListener(EVENTS.FOCUS, this.handleHiddenFieldFocusEvent);
    formFieldElement.addEventListener(EVENTS.INPUT, this.handleHiddenFieldInputEvent);
  }

  /**
   * Removes the fallback listener that facilitates setting up the inline
   *  menu on the field when it becomes visible and focused.
   *
   * @param formFieldElement - The form field element that triggered the focus event.
   */
  private removeHiddenFieldFallbackListener(formFieldElement: ElementWithOpId<FormFieldElement>) {
    formFieldElement.removeEventListener(EVENTS.FOCUS, this.handleHiddenFieldFocusEvent);
    formFieldElement.removeEventListener(EVENTS.INPUT, this.handleHiddenFieldInputEvent);
    this.hiddenFormFieldElements.delete(formFieldElement);
  }

  /**
   * Handles the focus event on a hidden field. When
   * triggered, the inline menu is set up on the field.
   *
   * @param event - The focus event.
   */
  private handleHiddenFieldFocusEvent = (event: FocusEvent) => {
    const formFieldElement = event.target as ElementWithOpId<FormFieldElement>;
    this.handleHiddenElementFallbackEvent(formFieldElement);
  };

  /**
   * Handles an input event on a hidden field. When triggered, the inline menu is set up on the
   * field. We also capture the input value for the field to facilitate presentation of the value
   * for the field in the notification bar.
   *
   * @param event - The input event.
   */
  private handleHiddenFieldInputEvent = async (event: InputEvent) => {
    const formFieldElement = event.target as ElementWithOpId<FormFieldElement>;
    this.handleHiddenElementFallbackEvent(formFieldElement);
    await this.triggerFormFieldInput(formFieldElement);
  };

  /**
   * Handles updating the hidden element when a fallback event is triggered.
   *
   * @param formFieldElement - The form field element that triggered the focus event.
   */
  private handleHiddenElementFallbackEvent = (
    formFieldElement: ElementWithOpId<FormFieldElement>,
  ) => {
    const autofillFieldData = this.hiddenFormFieldElements.get(formFieldElement);
    if (autofillFieldData) {
      autofillFieldData.readonly = getAttributeBoolean(formFieldElement, "disabled");
      autofillFieldData.disabled = getAttributeBoolean(formFieldElement, "disabled");
      autofillFieldData.viewable = true;
      void this.setupOverlayListenersOnQualifiedField(formFieldElement, autofillFieldData);
    }

    this.removeHiddenFieldFallbackListener(formFieldElement);
  };

  /**
   * Sets up the inline menu on a qualified form field element.
   *
   * @param formFieldElement - The form field element to set up the inline menu on.
   * @param autofillFieldData - Autofill field data captured from the form field element.
   */
  private async setupOverlayListenersOnQualifiedField(
    formFieldElement: ElementWithOpId<FormFieldElement>,
    autofillFieldData: AutofillField,
  ) {
    this.formFieldElements.set(formFieldElement, autofillFieldData);

    if (!this.mostRecentlyFocusedField) {
      await this.updateMostRecentlyFocusedField(formFieldElement);
    }

    if (!this.inlineMenuVisibility) {
      await this.getInlineMenuVisibility();
    }

    this.setupFormFieldElementEventListeners(formFieldElement);
    this.setupFormSubmissionEventListeners(formFieldElement, autofillFieldData);

    if (
      globalThis.document.hasFocus() &&
      this.getRootNodeActiveElement(formFieldElement) === formFieldElement
    ) {
      await this.triggerFormFieldFocusedAction(formFieldElement);
    }
  }

  /**
   * Queries the background script for the autofill inline menu visibility setting.
   * If the setting is not found, a default value of OnFieldFocus will be used
   * @private
   */
  private async getInlineMenuVisibility() {
    const inlineMenuVisibility = await this.sendExtensionMessage("getAutofillInlineMenuVisibility");
    this.inlineMenuVisibility = inlineMenuVisibility || AutofillOverlayVisibility.OnFieldFocus;
  }

  /**
   * Returns a value that indicates if we should hide the inline menu list due to a filled field.
   *
   * @param formFieldElement - The form field element that triggered the focus event.
   */
  private async hideInlineMenuListOnFilledField(
    formFieldElement?: FillableFormFieldElement,
  ): Promise<boolean> {
    return (
      formFieldElement?.value &&
      ((await this.isInlineMenuCiphersPopulated()) || !this.isUserAuthed())
    );
  }

  /**
   * Indicates whether the most recently focused field has a value.
   */
  private mostRecentlyFocusedFieldHasValue() {
    return Boolean((this.mostRecentlyFocusedField as FillableFormFieldElement)?.value);
  }

  /**
   * Updates the local reference to the inline menu visibility setting.
   *
   * @param data - The data object from the extension message.
   */
  private updateInlineMenuVisibility({ data }: AutofillExtensionMessage) {
    if (!isNaN(data?.inlineMenuVisibility)) {
      this.inlineMenuVisibility = data.inlineMenuVisibility;
    }
  }

  /**
   * Checks if a field is currently filling within an frame in the tab.
   */
  private async isFieldCurrentlyFilling() {
    return (await this.sendExtensionMessage("checkIsFieldCurrentlyFilling")) === true;
  }

  /**
   * Checks if the inline menu button is visible at the top frame.
   */
  private async isInlineMenuButtonVisible() {
    return (await this.sendExtensionMessage("checkIsAutofillInlineMenuButtonVisible")) === true;
  }

  /**
   * Checks if the inline menu list if visible at the top frame.
   */
  private async isInlineMenuListVisible() {
    return (await this.sendExtensionMessage("checkIsAutofillInlineMenuListVisible")) === true;
  }

  /**
   * Checks if the field is currently focused within the top frame.
   */
  private async isFieldCurrentlyFocused() {
    return (await this.sendExtensionMessage("checkIsFieldCurrentlyFocused")) === true;
  }

  /**
   * Checks if the current tab contains ciphers that can be used to populate the inline menu.
   */
  private async isInlineMenuCiphersPopulated() {
    return (await this.sendExtensionMessage("checkIsInlineMenuCiphersPopulated")) === true;
  }

  /**
   * Gets the root node of the passed element and returns the active element within that root node.
   *
   * @param element - The element to get the root node active element for.
   */
  private getRootNodeActiveElement(element: Element): Element {
    if (!element) {
      return null;
    }

    const documentRoot = element.getRootNode() as ShadowRoot | Document;
    return documentRoot?.activeElement;
  }

  /**
   * Queries all iframe elements within the document and returns the
   * sub frame offsets for each iframe element.
   *
   * @param message - The message object from the extension.
   */
  private async getSubFrameOffsets(
    message: AutofillExtensionMessage,
  ): Promise<SubFrameOffsetData | null> {
    const { subFrameUrl } = message;

    const subFrameUrlVariations = this.getSubFrameUrlVariations(subFrameUrl);
    if (!subFrameUrlVariations) {
      return null;
    }

    let iframeElement: HTMLIFrameElement | null = null;
    const iframeElements = globalThis.document.getElementsByTagName("iframe");

    for (let iframeIndex = 0; iframeIndex < iframeElements.length; iframeIndex++) {
      const iframe = iframeElements[iframeIndex];
      if (!subFrameUrlVariations.has(iframe.src)) {
        continue;
      }

      if (iframeElement) {
        return null;
      }

      iframeElement = iframe;
    }

    if (!iframeElement) {
      return null;
    }

    return this.calculateSubFrameOffsets(iframeElement, subFrameUrl);
  }

  /**
   * Returns a set of all possible URL variations for the sub frame URL.
   *
   * @param subFrameUrl - The URL of the sub frame.
   */
  private getSubFrameUrlVariations(subFrameUrl: string) {
    try {
      const url = new URL(subFrameUrl, globalThis.location.href);
      const pathAndHash = url.pathname + url.hash;
      const pathAndSearch = url.pathname + url.search;
      const pathSearchAndHash = pathAndSearch + url.hash;
      const pathNameWithoutTrailingSlash = url.pathname.replace(/\/$/, "");
      const pathWithoutTrailingSlashAndHash = pathNameWithoutTrailingSlash + url.hash;
      const pathWithoutTrailingSlashAndSearch = pathNameWithoutTrailingSlash + url.search;
      const pathWithoutTrailingSlashSearchAndHash = pathWithoutTrailingSlashAndSearch + url.hash;

      return new Set([
        url.href,
        url.href.replace(/\/$/, ""),
        url.pathname,
        pathAndHash,
        pathAndSearch,
        pathSearchAndHash,
        pathNameWithoutTrailingSlash,
        pathWithoutTrailingSlashAndHash,
        pathWithoutTrailingSlashAndSearch,
        pathWithoutTrailingSlashSearchAndHash,
        url.hostname + url.pathname,
        url.hostname + pathAndHash,
        url.hostname + pathAndSearch,
        url.hostname + pathSearchAndHash,
        url.hostname + pathNameWithoutTrailingSlash,
        url.hostname + pathWithoutTrailingSlashAndHash,
        url.hostname + pathWithoutTrailingSlashAndSearch,
        url.hostname + pathWithoutTrailingSlashSearchAndHash,
        url.origin + url.pathname,
        url.origin + pathAndHash,
        url.origin + pathAndSearch,
        url.origin + pathSearchAndHash,
        url.origin + pathNameWithoutTrailingSlash,
        url.origin + pathWithoutTrailingSlashAndHash,
        url.origin + pathWithoutTrailingSlashAndSearch,
        url.origin + pathWithoutTrailingSlashSearchAndHash,
      ]);
    } catch (_error) {
      return null;
    }
  }

  /**
   * Posts a message to the parent frame to calculate the sub frame offset of the current frame.
   *
   * @param message - The message object from the extension.
   */
  private getSubFrameOffsetsFromWindowMessage(message: any) {
    globalThis.parent.postMessage(
      {
        command: "calculateSubFramePositioning",
        subFrameData: {
          url: window.location.href,
          frameId: message.subFrameId,
          left: 0,
          top: 0,
          parentFrameIds: [0],
          subFrameDepth: 0,
        } as SubFrameDataFromWindowMessage,
      },
      "*",
    );
  }

  /**
   * Calculates the bounding rect for the queried frame and returns the
   * offset data for the sub frame.
   *
   * @param iframeElement - The iframe element to calculate the sub frame offsets for.
   * @param subFrameUrl - The URL of the sub frame.
   * @param frameId - The frame ID of the sub frame.
   */
  private calculateSubFrameOffsets(
    iframeElement: HTMLIFrameElement,
    subFrameUrl?: string,
    frameId?: number,
  ): SubFrameOffsetData {
    const iframeRect = iframeElement.getBoundingClientRect();
    const iframeStyles = globalThis.getComputedStyle(iframeElement);
    const paddingLeft = parseInt(iframeStyles.getPropertyValue("padding-left")) || 0;
    const paddingTop = parseInt(iframeStyles.getPropertyValue("padding-top")) || 0;
    const borderWidthLeft = parseInt(iframeStyles.getPropertyValue("border-left-width")) || 0;
    const borderWidthTop = parseInt(iframeStyles.getPropertyValue("border-top-width")) || 0;

    return {
      url: subFrameUrl,
      frameId,
      top: iframeRect.top + paddingTop + borderWidthTop,
      left: iframeRect.left + paddingLeft + borderWidthLeft,
    };
  }

  /**
   * Calculates the sub frame positioning for the current frame
   * through all parent frames until the top frame is reached.
   *
   * @param event - The message event.
   */
  private calculateSubFramePositioning = async (event: MessageEvent) => {
    const subFrameData: SubFrameDataFromWindowMessage = event.data.subFrameData;

    subFrameData.subFrameDepth++;
    if (subFrameData.subFrameDepth >= MAX_SUB_FRAME_DEPTH) {
      void this.sendExtensionMessage("destroyAutofillInlineMenuListeners", { subFrameData });
      return;
    }

    let subFrameOffsets: SubFrameOffsetData;
    const iframes = globalThis.document.querySelectorAll("iframe");
    for (let i = 0; i < iframes.length; i++) {
      if (iframes[i].contentWindow === event.source) {
        const iframeElement = iframes[i];
        subFrameOffsets = this.calculateSubFrameOffsets(
          iframeElement,
          subFrameData.url,
          subFrameData.frameId,
        );

        subFrameData.top += subFrameOffsets.top;
        subFrameData.left += subFrameOffsets.left;

        const parentFrameId = await this.sendExtensionMessage("getCurrentTabFrameId");
        if (typeof parentFrameId !== "undefined") {
          subFrameData.parentFrameIds.push(parentFrameId);
        }

        break;
      }
    }

    if (globalThis.window.self !== globalThis.window.top) {
      globalThis.parent.postMessage({ command: "calculateSubFramePositioning", subFrameData }, "*");
      return;
    }

    void this.sendExtensionMessage("updateSubFrameData", { subFrameData });
  };

  /**
   * Sets up global event listeners and the mutation
   * observer to facilitate required changes to the
   * overlay elements.
   */
  private setupGlobalEventListeners = () => {
    globalThis.addEventListener(EVENTS.MESSAGE, this.handleWindowMessageEvent);
    globalThis.document.addEventListener(EVENTS.VISIBILITYCHANGE, this.handleVisibilityChangeEvent);
    globalThis.addEventListener(EVENTS.FOCUSOUT, this.handleFormFieldBlurEvent);
    this.setOverlayRepositionEventListeners();
  };

  /**
   * Handles window messages that are sent to the current frame. Will trigger a
   * calculation of the sub frame offsets through the parent frame.
   *
   * @param event - The message event.
   */
  private handleWindowMessageEvent = (event: MessageEvent) => {
    if (event.data?.command === "calculateSubFramePositioning") {
      void this.calculateSubFramePositioning(event);
    }
  };

  /**
   * Handles the visibility change event. This method will remove the
   * autofill overlay if the document is not visible.
   */
  private handleVisibilityChangeEvent = () => {
    if (!this.mostRecentlyFocusedField || globalThis.document.visibilityState === "visible") {
      return;
    }

    this.unsetMostRecentlyFocusedField();
    void this.sendExtensionMessage("closeAutofillInlineMenu", {
      forceCloseInlineMenu: true,
    });
  };

  /**
   * Sets up event listeners that facilitate repositioning
   * the overlay elements on scroll or resize.
   */
  private setOverlayRepositionEventListeners() {
    const handler = this.useEventHandlersMemo(
      throttle(this.handleOverlayRepositionEvent, 250),
      AUTOFILL_OVERLAY_HANDLE_REPOSITION,
    );
    globalThis.addEventListener(EVENTS.SCROLL, handler, {
      capture: true,
      passive: true,
    });
    globalThis.addEventListener(EVENTS.RESIZE, handler);
  }

  /**
   * Removes the listeners that facilitate repositioning
   * the overlay elements on scroll or resize.
   */
  private removeOverlayRepositionEventListeners() {
    const handler = this.eventHandlersMemo[AUTOFILL_OVERLAY_HANDLE_REPOSITION];
    globalThis.removeEventListener(EVENTS.SCROLL, handler, {
      capture: true,
    });
    globalThis.removeEventListener(EVENTS.RESIZE, handler);

    delete this.eventHandlersMemo[AUTOFILL_OVERLAY_HANDLE_REPOSITION];
  }

  /**
   * Handles the resize or scroll events that enact
   * repositioning of existing overlay elements.
   */
  private handleOverlayRepositionEvent = async () => {
    await this.sendExtensionMessage("triggerAutofillOverlayReposition");
  };

  /**
   * Sets up listeners that facilitate a rebuild of the sub frame offsets
   * when a user interacts or focuses an element within the frame.
   */
  private setupRebuildSubFrameOffsetsListeners = () => {
    if (globalThis.window.top === globalThis.window || this.formFieldElements.size < 1) {
      return;
    }
    this.removeSubFrameFocusOutListeners();

    globalThis.addEventListener(EVENTS.FOCUS, this.handleSubFrameFocusInEvent);
    globalThis.document.body.addEventListener(EVENTS.MOUSEENTER, this.handleSubFrameFocusInEvent);
  };

  /**
   * Removes the listeners that facilitate a rebuild of the sub frame offsets.
   */
  private removeRebuildSubFrameOffsetsListeners = () => {
    globalThis.removeEventListener(EVENTS.FOCUS, this.handleSubFrameFocusInEvent);
    globalThis.document.body.removeEventListener(
      EVENTS.MOUSEENTER,
      this.handleSubFrameFocusInEvent,
    );
  };

  /**
   * Re-establishes listeners that handle the sub frame offsets rebuild of the frame
   * based on user interaction with the sub frame.
   */
  private setupSubFrameFocusOutListeners = () => {
    globalThis.addEventListener(EVENTS.BLUR, this.setupRebuildSubFrameOffsetsListeners);
    globalThis.document.body.addEventListener(
      EVENTS.MOUSELEAVE,
      this.setupRebuildSubFrameOffsetsListeners,
    );
  };

  /**
   * Removes the listeners that trigger when a user focuses away from the sub frame.
   */
  private removeSubFrameFocusOutListeners = () => {
    globalThis.removeEventListener(EVENTS.BLUR, this.setupRebuildSubFrameOffsetsListeners);
    globalThis.document.body.removeEventListener(
      EVENTS.MOUSELEAVE,
      this.setupRebuildSubFrameOffsetsListeners,
    );
  };

  /**
   * Sends a message to the background script to trigger a rebuild of the sub frame
   * offsets. Will deregister the listeners to ensure that other focus and mouse
   * events do not unnecessarily re-trigger a sub frame rebuild.
   */
  private handleSubFrameFocusInEvent = () => {
    void this.sendExtensionMessage("triggerSubFrameFocusInRebuild");

    this.removeRebuildSubFrameOffsetsListeners();
    this.setupSubFrameFocusOutListeners();
  };

  /**
   * Triggers an update in the most recently focused field's data and returns
   * whether the field is within the viewport bounds. If not within the bounds
   * of the viewport, the inline menu will be closed.
   */
  private async checkIsMostRecentlyFocusedFieldWithinViewport() {
    await this.updateMostRecentlyFocusedField(this.mostRecentlyFocusedField);

    const focusedFieldRectsTop = this.focusedFieldData?.focusedFieldRects?.top;
    const focusedFieldRectsBottom =
      focusedFieldRectsTop + this.focusedFieldData?.focusedFieldRects?.height;
    const viewportHeight = globalThis.innerHeight + globalThis.scrollY;
    return (
      !globalThis.isNaN(focusedFieldRectsTop) &&
      focusedFieldRectsTop >= 0 &&
      focusedFieldRectsTop < viewportHeight &&
      focusedFieldRectsBottom <= viewportHeight
    );
  }

  /**
   * Clears the timeout that triggers a debounced focus of the inline menu list.
   */
  private clearFocusInlineMenuListTimeout() {
    if (this.focusInlineMenuListTimeout) {
      globalThis.clearTimeout(this.focusInlineMenuListTimeout);
    }
  }

  /**
   * Clears the timeout that triggers the closing of the inline menu on a focus redirection.
   */
  private clearCloseInlineMenuOnRedirectTimeout() {
    if (this.closeInlineMenuOnRedirectTimeout) {
      globalThis.clearTimeout(this.closeInlineMenuOnRedirectTimeout);
    }
  }

  /**
   * Force an update to the background focused field data.
   */
  async forceUpdateFocusedFieldData(autofillFieldElement: ElementWithOpId<FormFieldElement>) {
    if (this.mostRecentlyFocusedField == autofillFieldElement) {
      await this.updateMostRecentlyFocusedField(autofillFieldElement);
    }
  }

  /**
   * Destroys the autofill overlay content service. This method will
   * disconnect the mutation observers and remove all event listeners.
   */
  destroy() {
    this.clearFocusInlineMenuListTimeout();
    this.clearCloseInlineMenuOnRedirectTimeout();
    this.formFieldElements.forEach((_autofillField, formFieldElement) => {
      this.removeCachedFormFieldEventListeners(formFieldElement);
      formFieldElement.removeEventListener(EVENTS.BLUR, this.handleFormFieldBlurEvent);
      formFieldElement.removeEventListener(EVENTS.KEYUP, this.handleFormFieldKeyupEvent);
      this.formFieldElements.delete(formFieldElement);
    });
    Object.keys(this.userFilledFields).forEach((key) => {
      if (this.userFilledFields[key]) {
        delete this.userFilledFields[key];
      }
    });
    this.userFilledFields = null;
    globalThis.removeEventListener(EVENTS.MESSAGE, this.handleWindowMessageEvent);
    globalThis.document.removeEventListener(
      EVENTS.VISIBILITYCHANGE,
      this.handleVisibilityChangeEvent,
    );
    globalThis.removeEventListener(EVENTS.FOCUSOUT, this.handleFormFieldBlurEvent);
    this.removeOverlayRepositionEventListeners();
    this.removeRebuildSubFrameOffsetsListeners();
    this.removeSubFrameFocusOutListeners();
  }
}
