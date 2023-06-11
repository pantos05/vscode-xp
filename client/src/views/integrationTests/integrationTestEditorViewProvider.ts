import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';

import { ExtensionHelper } from '../../helpers/extensionHelper';
import { MustacheFormatter } from '../mustacheFormatter';
import { EventMimeType as EventMimeType, TestHelper } from '../../helpers/testHelper';
import { IntegrationTest } from '../../models/tests/integrationTest';
import { Correlation } from '../../models/content/correlation';
import { Enrichment } from '../../models/content/enrichment';
import { RuleBaseItem } from '../../models/content/ruleBaseItem';
import { Configuration } from '../../models/configuration';
import { SiemjManager } from '../../models/siemj/siemjManager';
import { CorrelationUnitTestsRunner } from '../../models/tests/correlationUnitTestsRunner';
import { FileSystemHelper } from '../../helpers/fileSystemHelper';
import { IntegrationTestRunner } from '../../models/tests/integrationTestRunner';
import { RegExpHelper } from '../../helpers/regExpHelper';
import { FastTest } from '../../models/tests/fastTest';
import { VsCodeApiHelper } from '../../helpers/vsCodeApiHelper';
import { TestStatus } from '../../models/tests/testStatus';
import { SiemJOutputParser } from '../../models/siemj/siemJOutputParser';
import { ExceptionHelper } from '../../helpers/exceptionHelper';
import { XpException } from '../../models/xpException';
import { Enveloper } from '../../models/enveloper';
import { ExtensionState } from '../../models/applicationState';

export class IntegrationTestEditorViewProvider  {

	public static readonly viewId = 'IntegrationTestEditorView';
	public static readonly onTestSelectionChangeCommand = "IntegrationTestEditorView.onTestSelectionChange";

	private _view?: vscode.WebviewPanel;
	private _rule: RuleBaseItem;

	public constructor(
		private readonly _config: Configuration,
		private readonly _templatePath: string) {
	}

	public static init(config: Configuration) {

		// Форма создания визуалиации интеграционных тестов.
		const templatePath = path.join(
			config.getExtensionPath(), 
			path.join("client", "templates", "IntegrationTestEditor.html")
		);

		const provider = new IntegrationTestEditorViewProvider(config, templatePath);

		// Открытие формы тестов.
		config.getContext().subscriptions.push(
			vscode.commands.registerCommand(
				IntegrationTestEditorViewProvider.showEditorCommand, 
				async (rule: Correlation) => {
					// Обновляем интеграционные тесты для того, чтобы можно было увидеть актуальные тесты при их модификации на ЖД.
					rule.reloadIntegrationalTests();
					provider.showEditor(rule);
				}
			)
		);

		config.getContext().subscriptions.push(
			vscode.commands.registerCommand(
				IntegrationTestEditorViewProvider.onTestSelectionChangeCommand, 
				async (test: IntegrationTest) => {
					vscode.commands.executeCommand(IntegrationTestEditorViewProvider.showEditorCommand);
				}
			)
		);
	}

	public static readonly showEditorCommand = "IntegrationTestEditorView.showEditor";
	public async showEditor(rule: Correlation|Enrichment)  {

		if(this._view) {
			this._rule = null;
			this._view.dispose();
		}

		if(!(rule instanceof Correlation || rule instanceof Enrichment)) {
			return;
		}

		this._rule = rule;

		// Создать и показать панель.
		const viewTitle = `Тесты '${this._rule.getName()}'`;
		this._view = vscode.window.createWebviewPanel(
			IntegrationTestEditorViewProvider.viewId,
			viewTitle,
			vscode.ViewColumn.One, 
			{
				retainContextWhenHidden : true,
				enableFindWidget : true
			});

		this._view.webview.options = {
			enableScripts: true
		};

		this._view.webview.onDidReceiveMessage(
			this.receiveMessageFromWebView,
			this
		);

		await this.updateView();
	}

	private async updateView(focusTestNumber?: number) : Promise<void> {

		const intergrationalTest = this._rule.getIntegrationTests();

		const resoucesUri = this._config.getExtensionUri();
		const extensionBaseUri = this._view.webview.asWebviewUri(resoucesUri);

		const plain = {
			"IntegrationalTests" : [],
			"ExtensionBaseUri" : extensionBaseUri, 
			"RuleName" : this._rule.getName(),
			"ActiveTestNumber" : focusTestNumber == null ? 1 : focusTestNumber,
		};

		try {
			// Если тестов нет, то создаём пустую форму для первого теста
			if (intergrationalTest.length === 0){
				plain["IntegrationalTests"].push({
					"TestNumber" : 1,
					"RawEvents" : '',
					"NormEvent" : '',
					"TestCode" : `expect 1 {"correlation_name" : "${this._rule.getName()}"}`,
					"TestOutput" : '',
					"JsonedTestObject" : '',
					"TestStatus" : '',
				});
			}
			else{
				intergrationalTest.forEach(it => {
					const jsonedTestObject = JSON.stringify(it);

					const formattedTestCode = TestHelper.formatTestCodeAndEvents(it.getTestCode());
					const formattedNormalizedEvents = TestHelper.formatTestCodeAndEvents(it.getNormalizedEvents());

					let testStatusStyle : string;
					const testStatus = it.getStatus();
					switch(testStatus) {
						case TestStatus.Unknown: {
							testStatusStyle = "";
							break;
						}
						case TestStatus.Success: {
							testStatusStyle = "success";
							break;
						}
						case TestStatus.Failed: {
							testStatusStyle = "failure";
							break;
						}
					}

					plain["IntegrationalTests"].push({
						"TestNumber" : it.getNumber(),
						"RawEvents" : it.getRawEvents(),
						"NormEvent" : formattedNormalizedEvents,
						"TestCode" : formattedTestCode,
						"TestOutput" : it.getOutput(),
						"JsonedTestObject" : jsonedTestObject,
						"TestStatus" : testStatusStyle,
					});
				});
			}

			const template = await FileSystemHelper.readContentFile(this._templatePath);
			const formatter = new MustacheFormatter(template);
			const htmlContent = formatter.format(plain);

			this._view.webview.html = htmlContent;
		}
		catch(error) {
			ExtensionHelper.showError("Не удалось открыть интеграционные тесты.", error);
		}
	}

	private async receiveMessageFromWebView(message: any) {

		await this.runToolingAction(message);

		// События, не требующие запуска утилит.
		switch (message.command) {
			case 'saveTest': {
				const currTest = IntegrationTest.convertFromObject(message.test);
				try {
					await this.saveTest(message);
				}
				catch(error) {
					ExceptionHelper.show(error, `Не удалось сохранить тест №${currTest}.`);
					return;
				}

				const activeTestNumber = this.getActiveTestNumber(message);
				this.updateView(activeTestNumber);
				return;
			}

			case 'saveAllTests': {
				try {
					await this.saveAllTests(message);
					ExtensionHelper.showUserInfo(`Все тесты сохранены.`);
				
					// Добавляем в DOM новый тест.
					const activeTestNumber = this.getActiveTestNumber(message);
					this.updateView(activeTestNumber);
				}
				catch(error) {
					ExceptionHelper.show(error, `Не удалось сохранить тест`);
				}
				return;
			}

			case 'addEnvelope': {
				const rawEvents = message?.rawEvents as string;
				const mimeType = message?.mimeType as EventMimeType;
                
                return vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    cancellable: false,
                    title: `Идёт добавление конверта на сырые события`
                }, async (progress) => {
                    try {
                        return this.addEnvelope(rawEvents, mimeType);
                    }
                    catch(error) {
                        ExceptionHelper.show(error, "Ошибка добавления конверта на сырые события");
                    }
                });
			}

			case 'cleanTestCode': {
				return this.cleanTestCode(message);
			}
		}
	}

	private async runToolingAction(message : any) {
		// Проверяем, что комманда использует утилиты.
		const commandName = message.command as string;
		if(!['normalize', 'normalizeAndEnrich', 'fastTest', 'fullTest'].includes(commandName)) {
			return;
		}

		if(ExtensionState.get().isToolingExecution()) {
			return ExtensionHelper.showUserError("Дождитесь окончания выполняющихся процессов и повторите.");
		}

		ExtensionState.get().runToolingExecution();

		try {
			switch (message.command) {
				case 'normalize': {
					if(!message.test) {
						ExtensionHelper.showUserError("Сохраните тест перед запуском нормализации сырых событий и повторите действие.");
						return;
					}
	
					// Актуализируем сырые события в тесте из вьюшки.
					const rawEvents = message.rawEvents;
					const currTest = IntegrationTest.convertFromObject(message.test);
					currTest.setRawEvents(rawEvents);
					await currTest.save();
	
					await this.normalizeRawEvents(false, currTest);
					break;
				}
				case 'normalizeAndEnrich': {
					if(!message.test) {
						ExtensionHelper.showUserError("Сохраните тест перед запуском нормализации сырых событий и повторите действие.");
						return;
					}
	
					// Актуализируем сырые события в тесте из вьюшки.
					const rawEvents = message.rawEvents;
					const currTest = IntegrationTest.convertFromObject(message.test);
					currTest.setRawEvents(rawEvents);
					await currTest.save();

					await this.normalizeRawEvents(true, currTest);
					break;
				}

				case 'fastTest': {
					await this.fastTest(message);
					break;
				}

				case 'fullTest': {
					await this.runFullTests(message);

					const activeTestNumber = this.getActiveTestNumber(message);
					await this.updateView(activeTestNumber);
					break;
				}
			}
		}
		catch(error) {
			ExceptionHelper.show(error, "Ошибка запуска.");
		}
		finally {
			ExtensionState.get().stopRoolingExecution();
		}
	}

	private getActiveTestNumber(message : any) : number {
		const activeTestNumberString = message?.activeTestNumber;
		if(!activeTestNumberString) {
			ExtensionHelper.showUserError(`Не задан номер активного теста.`);
			return;
		}

		const activeTestNumber = parseInt(activeTestNumberString);
		return activeTestNumber;
	}

	private async cleanTestCode(message: any) {
		if(!message.test) {
			ExtensionHelper.showUserError("Сохраните тест перед запуском нормализации сырых событий и повторите действие.");
			return;
		}
		
		let test: IntegrationTest; 
		try {
			const testCode = message?.testCode;
			if(!testCode) {
				throw new Error("Не удалось получить условия выполнения теста из интерфейса редактирования интеграционных тестов.");
			}

			test = IntegrationTest.convertFromObject(message.test);

			// Обновляем и сохраняем тест.
			const cleanedTestCode = TestHelper.cleanTestCode(testCode);

			this._view.webview.postMessage({
				'command': 'updateTestCode',
				'cleanedTestCode': cleanedTestCode
			});
		}
		catch (error) {
			ExtensionHelper.showError(`Не удалось очистить код теста №${test.getNumber()}`, error);
		}
	}

	public async addEnvelope(rawEvents: string, mimeType: EventMimeType) {
		
		let envelopedRawEventsString : string;
		try {
			envelopedRawEventsString = await Enveloper.addEnvelope(rawEvents, mimeType);
		}
		catch(error) {
			ExceptionHelper.show(error, "Ошибка добавления конверта.");
			return;
		}

		this._view.webview.postMessage({
			'command': 'updateRawEvents',
			'rawEvents': envelopedRawEventsString
		});
	}

	private async normalizeRawEvents(enrich: boolean, test: IntegrationTest) {

		const rawEventsFilePath = test.getRawEventsFilePath();

		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			cancellable: false,
			title: `Нормализация событий для теста №${test.getNumber()}`
		}, async (progress) => {

			try {
				const siemjManager = new SiemjManager(this._config);
				let normEvents : string;
				if(enrich) {
					normEvents = await siemjManager.normalizeAndEnrich(this._rule, rawEventsFilePath);
				} else {
					normEvents = await siemjManager.normalize(this._rule, rawEventsFilePath);
				}
				
				test.setNormalizedEvents(normEvents);
			}
			catch(error) {
				ExceptionHelper.show(error, "Не удалось нормализовать событие.");
				this._config.getOutputChannel().show();
				return;
			}

			// Обновление теста.
			const tests = this._rule.getIntegrationTests();
			const ruleTestIndex = tests.findIndex(it => it.getNumber() == test.getNumber());
			if(ruleTestIndex == -1) {
				ExtensionHelper.showUserError("Не удалось обновить интеграционный тест.");
				return;
			}

			ExtensionHelper.showUserInfo("Нормализация сырого события завершена успешно.");

			// Обновляем правило.
			tests[ruleTestIndex] = test;
			this.updateView(test.getNumber());
		});
	}

	async fastTest(message: any) {

		await VsCodeApiHelper.saveRuleCodeFile(this._rule);

		const currTest = IntegrationTest.convertFromObject(message.test);
		let integrationalTestSimplifiedContent = "";
		let normalizedEvents = "";
		try {
			normalizedEvents = currTest.getNormalizedEvents();
			if(!normalizedEvents) {
				ExtensionHelper.showUserError("Для запуска быстрого теста нужно хотя бы одно нормализованное событие. Нормализуйте сырые события, и повторите действие.");
				return;
			}

			// Временно создать модульный тест путём добавления к интеграционному нормализованного события в конец файла.
			// Убираем фильтр по полям в тесте, так как в модульном тесте нет обогащения, поэтому проверяем только сработку теста.
			const integrationalTestPath = currTest.getTestCodeFilePath();
			const integrationalTestContent = await FileSystemHelper.readContentFile(integrationalTestPath);
			integrationalTestSimplifiedContent = integrationalTestContent.replace(
				RegExpHelper.getExpectSection(), 
				"expect $1 {}");
		}
		catch (error) {
			ExtensionHelper.showError("Не удалось сформировать условия выполнения быстрого теста.", error);
			return;
		}

		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			cancellable: false,
			title: `Запущен быстрый тест №${currTest.getNumber()}`
		}, async (progress) => {

			const modularTestContent = `${integrationalTestSimplifiedContent}\n\n${normalizedEvents}`;

			// Сохраняем модульный тест во временный файл.
			const rootPath = this._config.getRootByPath(currTest.getRuleDirectoryPath());
			const rootFolder = path.basename(rootPath);
			const randTmpPath = this._config.getRandTmpSubDirectoryPath(rootFolder);
			await fs.promises.mkdir(randTmpPath, {recursive: true});

			const fastTestFilePath = path.join(randTmpPath, "fast_test.sc");
			await FileSystemHelper.writeContentFile(fastTestFilePath, modularTestContent);

			// Создаем временный модульный тест для быстрого тестирования.
			const fastTest = new FastTest(currTest.getNumber());
			fastTest.setTestExpectationPath(fastTestFilePath);
			fastTest.setRule(this._rule);

			const testRunner = this._rule.getUnitTestRunner();
			try {
				const resultTest = await testRunner.run(fastTest);

				switch (resultTest.getStatus()) {
					case TestStatus.Success: {
						ExtensionHelper.showUserInfo(`Быстрый тест ${resultTest.getNumber()} пройден успешно.`);
						break;
					}
					case TestStatus.Failed: {
						ExtensionHelper.showUserError(`Быстрый тест ${resultTest.getNumber()} завершился неуспешно.`);
						break;
					}
				}

				// Обновление теста.
				const tests = this._rule.getIntegrationTests();
				const ruleTestIndex = tests.findIndex( it => it.getNumber() == resultTest.getNumber());
				if(ruleTestIndex == -1) {
					ExtensionHelper.showUserError("Не удалось обновить интеграционный тест.");
					return;
				}

				// Переносим данные из быстрого теста в модульный.
				// При этом вывод теста содержит событие, подходящее под expect секцию, поэтому очищаем его как и код теста.
				const result = resultTest.getOutput();
				const clearedResult = TestHelper.cleanTestCode(result);

				// Вывод в тесте пока только храниться, а мы обновим его непосредственно.
				tests[ruleTestIndex].setOutput(clearedResult);
				this._config.getOutputChannel().clear();
				this._config.getOutputChannel().append(clearedResult);

				// Удаляем временные файлы.
				return fs.promises.rmdir(randTmpPath, {recursive : true});
			} 
			catch(error) {
				ExceptionHelper.show(error, 'Не удалось запустить быстрый тест.');
			}
		});
	}

	private async runFullTests(message: any) : Promise<boolean> {

		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			cancellable: false,
			title: `Интеграционные тесты для правила '${this._rule.getName()}'`
		}, async (progress) => {

			await VsCodeApiHelper.saveRuleCodeFile(this._rule);

			let tests : IntegrationTest [] = [];
			try {
				// Сохраняем активные тесты.
				const rule = await TestHelper.saveAllTest(message, this._rule);
				tests = rule.getIntegrationTests();
			}
			catch(error) {
				ExceptionHelper.show(error, `Не удалось сохранить тесты`);
				return false;
			}

			if(tests.length == 0) {
				vscode.window.showInformationMessage(`Тесты для правила '${this._rule.getName()}' не найдены. Добавьте хотя бы один тест и повторите.`);
				return false;
			}

			try {
				const outputParser = new SiemJOutputParser();
				const testRunner = new IntegrationTestRunner(this._config, outputParser);
				const executedTests = await testRunner.run(this._rule);

				if(executedTests.every(it => it.getStatus() === TestStatus.Success)) {
					ExtensionHelper.showUserInfo(`Интеграционные тесты прошли успешно.`);
					return true;
				} 
			}
			catch(error) {
				ExceptionHelper.show(error, `Ошибка запуска тестов`);
				return false;
			}
		});
	}

	async saveTest(message: any) : Promise<IntegrationTest> {
		// Обновляем и сохраняем тест.
		const test = await TestHelper.saveIntegrationTest(this._rule, message);
		ExtensionHelper.showUserInfo(`Тест №${test.getNumber()} сохранен.`);
		return test;
	}

	async saveAllTests(message: any) {

		// Номер активного теста.
		const activeTestNumberString = message?.activeTestNumber;
		if(!activeTestNumberString) {
			throw new XpException(`Не задан номер активного теста.`);
		}

		await TestHelper.saveAllTest(message, this._rule);
	}
}
