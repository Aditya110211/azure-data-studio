/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as azdata from 'azdata';
import * as vscode from 'vscode';
import { MigrationWizardPage } from '../models/migrationWizardPage';
import { LoginMigrationValidationResult, MigrationStateModel, StateChangeEvent, ValidateLoginMigrationValidationState } from '../models/stateMachine';
import * as constants from '../constants/strings';
import { debounce, getLoginStatusImage, getLoginStatusMessage, getSourceLogins } from '../api/utils';
import * as styles from '../constants/styles';
import { collectTargetLogins, LoginTableInfo } from '../api/sqlUtils';
import { IconPathHelper } from '../constants/iconPathHelper';
import * as utils from '../api/utils';
import { getTelemetryProps, logError, sendSqlMigrationActionEvent, TelemetryAction, TelemetryViews } from '../telemetry';
import { CollectingSourceLoginsFailed, CollectingTargetLoginsFailed } from '../models/loginMigrationModel';
import { WizardController } from './wizardController';
import { Tab } from 'azdata';
import { LoginPreMigrationValidationDialog } from '../dialog/loginMigration/loginPreMigrationValidationDialog';
import { EOL } from 'os';

const VALIDATE_LOGIN_MIGRATION_CUSTOM_BUTTON_INDEX = 0;

export class LoginSelectorPage extends MigrationWizardPage {
	private _view!: azdata.ModelView;
	private _disposables: vscode.Disposable[] = [];
	private _isCurrentPage: boolean;
	private _refreshResultsInfoBox!: azdata.InfoBoxComponent;
	private _windowsAuthInfoBox!: azdata.InfoBoxComponent;
	private _refreshButton!: azdata.ButtonComponent;
	private _refreshLoading!: azdata.LoadingComponent;
	private _aadDomainNameContainer!: azdata.FlexContainer;
	private _tabs!: azdata.TabbedPanelComponent;
	// variables for source non-system type logins
	private _nonSystemloginTablesTab!: Tab;
	private _loginSelectorTable!: azdata.TableComponent;
	private _loginNames!: string[];
	private _loginCount!: azdata.TextComponent;
	private _loginTableValues!: any[];
	private _filterTableValue!: string;
	// variables for source system type logins
	private _systemLoginTablesTab!: Tab;
	private _systemLoginTable!: azdata.TableComponent;
	private _systemLoginTableValues!: any[];
	private _filterSystemLoginTableValue!: string;
	private _successfullyValidatedLogins: Set<string> = new Set<string>();
	private _successfullyValidatedEntraDomain!: String;


	constructor(wizard: azdata.window.Wizard, migrationStateModel: MigrationStateModel, private wizardController: WizardController) {
		super(wizard, azdata.window.createWizardPage(constants.LOGIN_MIGRATIONS_SELECT_LOGINS_PAGE_TITLE), migrationStateModel);
		this._isCurrentPage = false;
	}

	protected async registerContent(view: azdata.ModelView): Promise<void> {
		this._view = view;

		const flex = view.modelBuilder.flexContainer().withLayout({
			flexFlow: 'column',
			height: '100%',
			width: '100%'
		}).component();
		flex.addItem(await this.createRootContainer(view), { flex: '1 1 auto' });

		this._disposables.push(
			this.wizard.customButtons[VALIDATE_LOGIN_MIGRATION_CUSTOM_BUTTON_INDEX].onClick(
				async e => await this._validateLoginPreMigration()));

		this._disposables.push(this._view.onClosed(e => {
			this._disposables.forEach(
				d => { try { d.dispose(); } catch { } });
		}));

		await view.initializeModel(flex);
	}

	public async onPageEnter(): Promise<void> {
		this.wizardController.cancelReasonsList([
			constants.WIZARD_CANCEL_REASON_CONTINUE_WITH_MIGRATION_LATER,
			constants.WIZARD_CANCEL_REASON_NEED_TO_REVIEW_LOGIN_SELECTION
		]);

		this.wizard.customButtons[VALIDATE_LOGIN_MIGRATION_CUSTOM_BUTTON_INDEX].hidden = false;

		this._isCurrentPage = true;
		this.updateNextButton();

		this.wizard.registerNavigationValidator((pageChangeInfo) => {
			this.wizard.message = {
				text: '',
				level: azdata.window.MessageLevel.Error
			};

			if (pageChangeInfo.newPage < pageChangeInfo.lastPage) {
				return true;
			}

			if (this.selectedLogins().length === 0 || !this.migrationStateModel.isLoginMigrationTargetValidated) {
				this.wizard.message = {
					text: constants.SELECT_LOGIN_AND_RUN_VALIDATION_TO_CONTINUE,
					level: azdata.window.MessageLevel.Error
				};
				return false;
			}

			if (this.migrationStateModel._loginMigrationModel.selectedWindowsLogins) {
				if (!this.migrationStateModel._aadDomainName) {
					this.wizard.message = {
						text: constants.ENTER_ENTRA_ID,
						level: azdata.window.MessageLevel.Error
					};
					return false;
				}
				else if (this._successfullyValidatedEntraDomain !== this.migrationStateModel._aadDomainName) {
					this.wizard.message = {
						text: constants.ENTRA_DOMAIN_NOT_VALIDATED,
						level: azdata.window.MessageLevel.Error
					};
					return false;
				}
			}

			if (!this._isAllSelectedLoginsValidated()) {
				this.wizard.message = {
					text: constants.VALIDATE_ALL_LOGINS,
					level: azdata.window.MessageLevel.Error
				};
				return false;
			}
			return true;
		});

		// Dispaly windows auth info box if windows auth is not supported
		await utils.updateControlDisplay(this._windowsAuthInfoBox, !this.migrationStateModel.isWindowsAuthMigrationSupported);

		// Refresh login list
		await this._loadLoginList(false);
	}

	public async onPageLeave(): Promise<void> {
		this.wizard.customButtons[VALIDATE_LOGIN_MIGRATION_CUSTOM_BUTTON_INDEX].hidden = true;

		this.wizard.registerNavigationValidator((pageChangeInfo) => {
			return true;
		});

		this._isCurrentPage = false;
		this.resetNextButton();
	}

	protected async handleStateChange(e: StateChangeEvent): Promise<void> {
	}

	private createSearchComponent(isSystemLogin: boolean): azdata.DivContainer {
		let resourceSearchBox = this._view.modelBuilder.inputBox().withProps({
			stopEnterPropagation: true,
			placeHolder: constants.SEARCH,
			width: 200
		}).component();

		if (isSystemLogin) {
			this._disposables.push(
				resourceSearchBox.onTextChanged(value => this._filterSystemTableList(value)));
		}
		else {
			this._disposables.push(
				resourceSearchBox.onTextChanged(value => this._filterTableList(value, this.migrationStateModel._loginMigrationModel.loginsForMigration || [])));
		}

		const searchContainer = this._view.modelBuilder.divContainer().withItems([resourceSearchBox]).withProps({
			CSSStyles: {
				'width': '200px',
				'margin-top': '8px'
			}
		}).component();

		return searchContainer;
	}

	private createAadDomainNameComponent(): azdata.FlexContainer {
		// target user name
		const aadDomainNameLabel = this._view.modelBuilder.text()
			.withProps({
				value: constants.LOGIN_MIGRATIONS_ENTRA_ID_INPUT_BOX_LABEL,
				requiredIndicator: false,
				CSSStyles: { ...styles.LABEL_CSS }
			}).component();

		const aadDomainNameInputBox = this._view.modelBuilder.inputBox()
			.withProps({
				width: '300px',
				inputType: 'text',
				placeHolder: constants.LOGIN_MIGRATIONS_ENTRA_ID_INPUT_BOX_PLACEHOLDER,
				required: false,
			}).component();

		this._disposables.push(
			aadDomainNameInputBox.onTextChanged(
				(value: string) => {
					this.migrationStateModel._aadDomainName = value ?? '';
				}));

		this._aadDomainNameContainer = this._view.modelBuilder.flexContainer()
			.withItems([
				aadDomainNameLabel,
				aadDomainNameInputBox])
			.withLayout({ flexFlow: 'column' })
			.withProps({ CSSStyles: { 'margin': '10px 0px 0px 0px', 'display': 'none' } })
			.component();

		return this._aadDomainNameContainer;
	}

	@debounce(500)
	private async _filterTableList(value: string, selectedList?: LoginTableInfo[]): Promise<void> {
		this._filterTableValue = value;
		const selectedRows: number[] = [];
		const selectedLogins = selectedList || this.selectedLogins();
		let tableRows = this._loginTableValues ?? [];
		if (this._loginTableValues && value?.length > 0) {
			tableRows = this._loginTableValues
				.filter(row => {
					const searchText = value?.toLowerCase();
					return row[1]?.toLowerCase()?.indexOf(searchText) > -1			// source login
						|| row[2]?.toLowerCase()?.indexOf(searchText) > -1			// login type
						|| row[3]?.toLowerCase()?.indexOf(searchText) > -1  		// default database
						|| row[4]?.toLowerCase()?.indexOf(searchText) > -1  	// status
						|| row[5]?.title?.toLowerCase()?.indexOf(searchText) > -1;			// target status
				});
		}

		for (let rowIdx = 0; rowIdx < tableRows.length; rowIdx++) {
			const login: string = tableRows[rowIdx][1];
			if (selectedLogins.some(selectedLogin => selectedLogin.loginName.toLowerCase() === login.toLowerCase())) {
				selectedRows.push(rowIdx);
			}
		}

		await this._loginSelectorTable.updateProperty('data', tableRows);
		this._loginSelectorTable.selectedRows = selectedRows;
		await this.updateValuesOnSelection();
	}

	private async _filterSystemTableList(value: string): Promise<void> {
		this._filterSystemLoginTableValue = value;
		let tableRows = this._systemLoginTableValues ?? [];
		if (this._systemLoginTableValues && value?.length > 0) {
			tableRows = this._systemLoginTableValues
				.filter(row => {
					const searchText = value?.toLowerCase();
					return row[0]?.toLowerCase()?.indexOf(searchText) > -1			// source login
						|| row[1]?.toLowerCase()?.indexOf(searchText) > -1			// login type
						|| row[2]?.toLowerCase()?.indexOf(searchText) > -1  		// default database
						|| row[3]?.toLowerCase()?.indexOf(searchText) > -1  	// status
						|| row[4]?.title?.toLowerCase()?.indexOf(searchText) > -1;			// target status
				});
		}

		await this._systemLoginTable.updateProperty('data', tableRows);
	}

	public async createRootContainer(view: azdata.ModelView): Promise<azdata.FlexContainer> {
		this._refreshButton = this._view.modelBuilder.button()
			.withProps({
				buttonType: azdata.ButtonType.Normal,
				iconHeight: 16,
				iconWidth: 16,
				iconPath: IconPathHelper.refresh,
				label: constants.DATABASE_TABLE_REFRESH_LABEL,
				width: 70,
				CSSStyles: { 'margin': '15px 5px 0 0' },
			})
			.component();

		this._disposables.push(
			this._refreshButton.onDidClick(
				async e => await this._loadLoginList()));

		this._refreshLoading = this._view.modelBuilder.loadingComponent()
			.withItem(this._refreshButton)
			.withProps({
				loading: false,
				CSSStyles: { 'margin-right': '20px', 'margin-top': '15px' }
			})
			.component();

		this._refreshResultsInfoBox = this._view.modelBuilder.infoBox()
			.withProps({
				style: 'success',
				text: '',
				announceText: true,
				CSSStyles: { 'display': 'none', 'margin-left': '5px' },
			})
			.component();

		const refreshContainer = this._view.modelBuilder.flexContainer()
			.withItems([
				this._refreshLoading,
				this._refreshResultsInfoBox],
				{ flex: '0 0 auto' })
			.withLayout({
				flexFlow: 'row',
				alignContent: 'center',
				alignItems: 'center',
			})
			.component();

		this._windowsAuthInfoBox = this._view.modelBuilder.infoBox()
			.withProps({
				style: 'information',
				text: constants.LOGIN_MIGRATIONS_SELECT_LOGINS_WINDOWS_AUTH_WARNING,
				CSSStyles: { ...styles.BODY_CSS, 'display': 'none', }
			}).component();

		await this._createSystemLoginTablesTab(view);
		await this._createNonSystemLoginTablesTab(view);

		this._tabs = view.modelBuilder.tabbedPanel()
			.withTabs([this._nonSystemloginTablesTab, this._systemLoginTablesTab])
			.withProps({
				CSSStyles: { 'margin-top': '8px', }
			})
			.component();

		const flex = view.modelBuilder.flexContainer().withLayout({
			flexFlow: 'column',
			height: '100%',
		}).withProps({
			CSSStyles: {
				'margin': '-20px 28px 0px 28px'
			}
		}).component();
		flex.addItem(this._windowsAuthInfoBox, { flex: '0 0 auto' });
		flex.addItem(refreshContainer, { flex: '0 0 auto' });
		flex.addItem(this._tabs, { flex: '0 0 auto' });
		return flex;
	}

	private async _createNonSystemLoginTablesTab(view: azdata.ModelView): Promise<void> {

		this._loginCount = this._view.modelBuilder.text().withProps({
			value: constants.LOGINS_SELECTED(
				this.selectedLogins().length,
				this._loginSelectorTable?.data?.length || 0),
			CSSStyles: {
				...styles.BODY_CSS,
				'margin-top': '8px'
			},
			ariaLive: 'polite'
		}).component();

		this._loginSelectorTable = this._createNonSystemLoginTablesTable(view);

		this._disposables.push(this._loginSelectorTable.onRowSelected(async (e) => {
			await this.updateValuesOnSelection();
		}));

		// load unfiltered table list and pre-select list of logins saved in state
		await this._filterTableList('', this.migrationStateModel._loginMigrationModel.loginsForMigration);

		const flex = view.modelBuilder.flexContainer()
			.withProps({ CSSStyles: { 'margin': '10px 0 0 15px' } })
			.withLayout({
				flexFlow: 'column',
				height: '100%',
				width: 550,
			}).component();

		flex.addItem(this.createSearchComponent(false), { flex: '0 0 auto' });
		flex.addItem(this._loginCount, { flex: '0 0 auto' });
		flex.addItem(this._loginSelectorTable);
		flex.addItem(this.createAadDomainNameComponent(), { flex: '0 0 auto', CSSStyles: { 'margin-top': '8px' } });

		this._nonSystemloginTablesTab = {
			content: flex,
			id: 'tableSelectionTab',
			title: constants.LOGIN_MIGRATIONS_SELECT_LOGINS_TAB_NON_SYSTEM_LOGIN_TITLE,
		};
	}

	private async _createSystemLoginTablesTab(view: azdata.ModelView): Promise<void> {
		this._systemLoginTable = this._createSystemLoginTablesTable(view);

		await this._filterSystemTableList('');

		const systemLoginInfoBox = view.modelBuilder.infoBox().withProps({
			text: constants.LOGIN_MIGRATIONS_SELECT_LOGINS_SYSTEM_LOGIN_INFO_BOX,
			style: 'information',
			width: 650,
			CSSStyles: {
				...styles.BODY_CSS
			}
		}).component();

		const flex = view.modelBuilder.flexContainer()
			.withProps({ CSSStyles: { 'margin': '10px 0 0 15px' } })
			.withLayout({
				flexFlow: 'column',
				height: '100%',
				width: 550,
			}).component();

		flex.addItem(systemLoginInfoBox, { flex: '0 0 auto' });
		flex.addItem(this.createSearchComponent(true), { flex: '0 0 auto' });
		flex.addItem(this._systemLoginTable, { flex: '0 0 auto' });

		this._systemLoginTablesTab = {
			content: flex,
			id: 'tableSelectionTab',
			title: constants.LOGIN_MIGRATIONS_SELECT_LOGINS_TAB_SYSTEM_LOGIN_TITLE,
		};
	}

	private _createNonSystemLoginTablesTable(view: azdata.ModelView): azdata.TableComponent {
		const cssClass = 'no-borders';
		const table = this._view.modelBuilder.table()
			.withProps({
				data: [],
				width: 650,
				height: '600px',
				display: 'flex',
				forceFitColumns: azdata.ColumnSizingMode.ForceFit,
				columns: [
					<azdata.CheckboxColumn>{
						value: '',
						width: 10,
						type: azdata.ColumnType.checkBox,
						action: azdata.ActionOnCellCheckboxCheck.selectRow,
						resizable: false,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					{
						name: constants.SOURCE_LOGIN,
						value: 'sourceLogin',
						type: azdata.ColumnType.text,
						width: 250,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					{
						name: constants.LOGIN_TYPE,
						value: 'loginType',
						type: azdata.ColumnType.text,
						width: 90,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					{
						name: constants.DEFAULT_DATABASE,
						value: 'defaultDatabase',
						type: azdata.ColumnType.text,
						width: 130,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					{
						name: constants.LOGIN_STATUS_COLUMN,
						value: 'status',
						type: azdata.ColumnType.text,
						width: 90,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					<azdata.HyperlinkColumn>{
						name: constants.LOGIN_TARGET_STATUS_COLUMN,
						value: 'targetStatus',
						width: 150,
						type: azdata.ColumnType.hyperlink,
						icon: IconPathHelper.inProgressMigration,
						showText: true,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
				]
			})
			.component();

		return table;
	}

	private _createSystemLoginTablesTable(view: azdata.ModelView): azdata.TableComponent {
		const cssClass = 'no-borders';
		const table = this._view.modelBuilder.table()
			.withProps({
				data: [],
				width: 650,
				height: '600px',
				display: 'flex',
				forceFitColumns: azdata.ColumnSizingMode.ForceFit,
				columns: [
					{
						name: constants.SOURCE_LOGIN,
						value: 'sourceLogin',
						type: azdata.ColumnType.text,
						width: 250,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					{
						name: constants.LOGIN_TYPE,
						value: 'loginType',
						type: azdata.ColumnType.text,
						width: 90,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					{
						name: constants.DEFAULT_DATABASE,
						value: 'defaultDatabase',
						type: azdata.ColumnType.text,
						width: 130,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					{
						name: constants.LOGIN_STATUS_COLUMN,
						value: 'status',
						type: azdata.ColumnType.text,
						width: 90,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
					<azdata.HyperlinkColumn>{
						name: constants.LOGIN_TARGET_STATUS_COLUMN,
						value: 'targetStatus',
						width: 150,
						type: azdata.ColumnType.hyperlink,
						icon: IconPathHelper.inProgressMigration,
						showText: true,
						cssClass: cssClass,
						headerCssClass: cssClass,
					},
				],
				CSSStyles: { 'margin-top': '8px' }
			})
			.component();

		return table;
	}

	private _isAllSelectedLoginsValidated(): boolean {
		return this.selectedLogins().every(login => this._successfullyValidatedLogins.has(login.loginName));
	}

	private async _getSourceLogins() {
		const stateMachine: MigrationStateModel = this.migrationStateModel;

		// execute a query against the source to get the logins
		try {
			await getSourceLogins(stateMachine);
		} catch (error) {
			this._refreshLoading.loading = false;
			this._refreshResultsInfoBox.style = 'error';
			this._refreshResultsInfoBox.text = constants.LOGIN_MIGRATION_REFRESH_SOURCE_LOGIN_DATA_FAILED;
			this.wizard.message = {
				level: azdata.window.MessageLevel.Error,
				text: constants.LOGIN_MIGRATIONS_GET_LOGINS_ERROR_TITLE('source'),
				description: constants.LOGIN_MIGRATIONS_GET_LOGINS_ERROR(error.message),
			};

			logError(TelemetryViews.LoginMigrationWizard, CollectingSourceLoginsFailed, error);

			sendSqlMigrationActionEvent(
				TelemetryViews.LoginMigrationSelectorPage,
				TelemetryAction.LoginMigrationError,
				{
					...getTelemetryProps(this.migrationStateModel),
					'errorMessage': CollectingSourceLoginsFailed,
				},
				{}
			);
		}
	}

	private async _getTargetLogins() {
		const stateMachine: MigrationStateModel = this.migrationStateModel;
		const targetLogins: string[] = [];

		// execute a query against the target to get the logins
		try {
			if (this.isTargetInstanceSet()) {
				targetLogins.push(...await collectTargetLogins(
					stateMachine.targetServerName,
					stateMachine._targetServerInstance.id,
					stateMachine._targetUserName,
					stateMachine._targetPassword,
					stateMachine._targetPort,
					stateMachine.isWindowsAuthMigrationSupported));
				stateMachine._loginMigrationModel.collectedTargetLogins = true;
				stateMachine._loginMigrationModel.loginsOnTarget = targetLogins;
			}
			else {
				// TODO AKMA : Emit telemetry here saying target info is empty
			}
		} catch (error) {
			this._refreshLoading.loading = false;
			this._refreshResultsInfoBox.style = 'error';
			this._refreshResultsInfoBox.text = constants.LOGIN_MIGRATION_REFRESH_TARGET_LOGIN_DATA_FAILED;
			this.wizard.message = {
				level: azdata.window.MessageLevel.Error,
				text: constants.LOGIN_MIGRATIONS_GET_LOGINS_ERROR_TITLE('target'),
				description: constants.LOGIN_MIGRATIONS_GET_LOGINS_ERROR(error.message),
			};

			logError(TelemetryViews.LoginMigrationWizard, CollectingTargetLoginsFailed, error);

			sendSqlMigrationActionEvent(
				TelemetryViews.LoginMigrationSelectorPage,
				TelemetryAction.LoginMigrationError,
				{
					...getTelemetryProps(this.migrationStateModel),
					'errorMessage': CollectingTargetLoginsFailed,
				},
				{}
			);
		}
	}

	private async _markRefreshDataStart() {
		this._refreshLoading.loading = true;
		this.wizard.nextButton.enabled = false;
		await utils.updateControlDisplay(this._refreshResultsInfoBox, true);
		this._refreshResultsInfoBox.text = constants.LOGIN_MIGRATION_REFRESHING_LOGIN_DATA;
		this._refreshResultsInfoBox.style = 'information';
	}

	private async _markRefreshDataComplete(numSourceLogins: number, numTargetLogins: number) {
		this._refreshLoading.loading = false;
		await utils.updateControlDisplay(this._refreshResultsInfoBox, true);
		this._refreshResultsInfoBox.text = constants.LOGIN_MIGRATION_REFRESH_LOGIN_DATA_SUCCESSFUL(numSourceLogins, numTargetLogins);
		this._refreshResultsInfoBox.style = 'success';
		this.updateNextButton();
	}

	private async _loadLoginList(runQuery: boolean = true): Promise<void> {
		const stateMachine: MigrationStateModel = this.migrationStateModel;
		const selectedLogins: LoginTableInfo[] = stateMachine._loginMigrationModel.loginsForMigration || [];

		// Get source logins if caller asked us to or if we haven't collected in the past
		if (runQuery || !stateMachine._loginMigrationModel.collectedSourceLogins) {
			await this._markRefreshDataStart();
			await this._getSourceLogins();
		}

		// Get target logins if caller asked us to or if we haven't collected in the past
		if (runQuery || !stateMachine._loginMigrationModel.collectedTargetLogins) {
			await this._markRefreshDataStart();
			await this._getTargetLogins();
		}

		var sourceLogins: LoginTableInfo[] = stateMachine._loginMigrationModel.loginsOnSource;
		var sourceSystemLogins: LoginTableInfo[] = stateMachine._loginMigrationModel.systemLoginsOnSource;

		const targetLogins: string[] = stateMachine._loginMigrationModel.loginsOnTarget;
		this._loginNames = [];

		this._loginTableValues = sourceLogins.map(row => {
			const loginName = row.loginName;
			this._loginNames.push(loginName);
			const isLoginOnTarget = targetLogins.some(targetLogin => targetLogin.toLowerCase() === loginName.toLowerCase());
			return [
				selectedLogins?.some(selectedLogin => selectedLogin.loginName.toLowerCase() === loginName.toLowerCase()),
				loginName,
				row.loginType,
				row.defaultDatabaseName,
				row.status,
				<azdata.HyperlinkColumnCellValue>{
					icon: getLoginStatusImage(isLoginOnTarget),
					title: getLoginStatusMessage(isLoginOnTarget),
				},
			];
		}) || [];
		await this._filterTableList(this._filterTableValue);

		this._systemLoginTableValues = sourceSystemLogins.map(row => {
			const isLoginOnTarget = targetLogins.some(targetLogin => targetLogin.toLowerCase() === row.loginName.toLowerCase());
			return [
				row.loginName,
				row.loginType,
				row.defaultDatabaseName,
				row.status,
				<azdata.HyperlinkColumnCellValue>{
					icon: getLoginStatusImage(isLoginOnTarget),
					title: getLoginStatusMessage(isLoginOnTarget),
				},
			];
		}) || [];
		await this._filterSystemTableList(this._filterSystemLoginTableValue);

		await this._markRefreshDataComplete(sourceLogins.length, targetLogins.length);
	}

	public selectedLogins(): LoginTableInfo[] {
		const rows = this._loginSelectorTable?.data || [];
		const logins = this._loginSelectorTable?.selectedRows || [];
		return logins
			.filter(rowIdx => rowIdx < rows.length)
			.map(rowIdx => {
				return {
					loginName: rows[rowIdx][1],
					loginType: rows[rowIdx][2],
					defaultDatabaseName: rows[rowIdx][3],
					status: rows[rowIdx][4].title,
				};
			})
			|| [];
	}

	private async refreshAADInputBox() {
		// Display AAD Domain Name input box only if windows logins selected, else disable
		const selectedWindowsLogins = this.migrationStateModel._loginMigrationModel.selectedWindowsLogins;
		await utils.updateControlDisplay(this._aadDomainNameContainer, selectedWindowsLogins);
		await this._loginSelectorTable.updateProperty("height", selectedWindowsLogins ? 600 : 650);
	}

	public updateValidationResultUI(initializing?: boolean): void {
		const succeeded = this.migrationStateModel.isLoginMigrationTargetValidated;
		this._successfullyValidatedLogins.clear();
		if (succeeded) {
			this._logLoginMigrationPreValidationSuccessful();
			this.selectedLogins().forEach(login => this._successfullyValidatedLogins.add(login.loginName));
			if (this.migrationStateModel._loginMigrationModel.selectedWindowsLogins) {
				this._successfullyValidatedEntraDomain = this.migrationStateModel._aadDomainName;
			}
			this.wizard.message = {
				level: azdata.window.MessageLevel.Information,
				text: constants.LOGIN_MIGRATION_VALIDATION_MESSAGE_SUCCESS,
			};
		} else {
			this._logLoginMigrationPreValidationFailed();
			const results = this.migrationStateModel._validateLoginMigration;
			const hasResults = results.length > 0;
			if (initializing && !hasResults) {
				return;
			}

			const canceled = results.some(result => result.state === ValidateLoginMigrationValidationState.Canceled);
			const errors: string[] = results.flatMap(result => result.errors) ?? [];
			const errorsMessage: string = errors.join(EOL);
			const hasErrors = errors.length > 0;
			const msg = hasResults
				? hasErrors
					? canceled
						? constants.VALIDATION_MESSAGE_CANCELED_ERRORS(errorsMessage)
						: constants.VALIDATE_LOGIN_MIGRATION_VALIDATION_COMPLETED_ERRORS(errorsMessage)
					: constants.VALIDATION_MESSAGE_CANCELED
				: constants.VALIDATION_MESSAGE_NOT_RUN;

			this.wizard.message = {
				level: azdata.window.MessageLevel.Error,
				text: msg,
			};
		}
	}

	private async _validateLoginPreMigration(): Promise<void> {
		if (this.migrationStateModel?._loginMigrationModel.loginsForMigration?.length <= 0) {
			this.wizard.message = {
				text: constants.SELECT_LOGIN_TO_CONTINUE,
				level: azdata.window.MessageLevel.Error
			};
			return;
		}

		const dialog = new LoginPreMigrationValidationDialog(
			this.migrationStateModel,
			() => this.updateValidationResultUI());
		let results: LoginMigrationValidationResult[] = [];
		results = this.migrationStateModel._validateLoginMigration;
		await dialog.openDialog(constants.VALIDATION_DIALOG_TITLE, results);
	}

	private async updateValuesOnSelection() {
		const selectedLogins = this.selectedLogins() || [];
		await this._loginCount.updateProperties({
			'value': constants.LOGINS_SELECTED(
				selectedLogins.length,
				this._loginSelectorTable.data?.length || 0)
		});

		this.migrationStateModel._loginMigrationModel.loginsForMigration = selectedLogins;
		await this.refreshAADInputBox();
		this.updateNextButton();
	}

	private updateNextButton() {
		// Only uppdate next label if we are currently on this page
		if (this._isCurrentPage) {
			this.wizard.nextButton.label = constants.LOGIN_MIGRATE_BUTTON_TEXT;
			this.wizard.nextButton.enabled = this.migrationStateModel?._loginMigrationModel.loginsForMigration?.length > 0;
		}
	}

	private resetNextButton() {
		this.wizard.nextButton.label = constants.NEXT_LABEL;
		this.wizard.nextButton.enabled = true;
	}

	private isTargetInstanceSet() {
		const stateMachine: MigrationStateModel = this.migrationStateModel;
		return stateMachine._targetServerInstance && stateMachine._targetUserName && stateMachine._targetPassword;
	}

	private _logLoginMigrationPreValidationSuccessful(): void {
		sendSqlMigrationActionEvent(
			TelemetryViews.LoginMigrationSelectorPage,
			TelemetryAction.LoginMigrationPreValidationSuccessful,
			{
				...getTelemetryProps(this.migrationStateModel),
				'loginsAuthType': this.migrationStateModel._loginMigrationModel.loginsAuthType,
			},
			{
				'numberLogins': this.migrationStateModel._loginMigrationModel.loginsForMigration.length,
			}
		);
	}

	private _logLoginMigrationPreValidationFailed(): void {
		sendSqlMigrationActionEvent(
			TelemetryViews.LoginMigrationSelectorPage,
			TelemetryAction.LoginMigrationPreValidationFailed,
			{
				...getTelemetryProps(this.migrationStateModel),
				'loginsAuthType': this.migrationStateModel._loginMigrationModel.loginsAuthType,
			},
			{
				'numberLogins': this.migrationStateModel._loginMigrationModel.loginsForMigration.length,
			}
		);
	}
}
