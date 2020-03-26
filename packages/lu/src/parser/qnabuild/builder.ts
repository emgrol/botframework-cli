/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {QnaBuildCore} from './core'
import {Settings} from './settings'
import {MultiLanguageRecognizer} from './multi-language-recognizer'
import {Recognizer} from './recognizer'
const path = require('path')
const fs = require('fs-extra')
const delay = require('delay')
const fileHelper = require('./../../utils/filehelper')
const fileExtEnum = require('./../utils/helpers').FileExtTypeEnum
const retCode = require('./../utils/enums/CLI-errors')
const exception = require('./../utils/exception')
const QnaBuilderVerbose = require('./../qna/qnamaker/kbCollate')
const LUOptions = require('./../lu/luOptions')
const Content = require('./../lu/qna')

export class Builder {
  private readonly handler: (input: string) => any

  constructor(handler: any) {
    this.handler = handler
  }

  async loadContents(
    files: string[],
    suffix: string,
    region: string,
    culture: string) {
    let multiRecognizers = new Map<string, MultiLanguageRecognizer>()
    let settings = new Map<string, Settings>()
    let recognizers = new Map<string, Recognizer>()
    let qnaContents: Array<any> = []

    for (const file of files) {
      const qnaFiles = await fileHelper.getLuObjects(undefined, file, true, fileExtEnum.QnAFile)

      let fileContent = ''
      let result
      try {
        result = await QnaBuilderVerbose.build(qnaFiles, true)
        fileContent = JSON.stringify(result)
      } catch (err) {
        err.text = `Invalid LU file ${file}: ${err.text}`
        throw(new exception(retCode.errorCode.INVALID_INPUT_FILE, err.text))
      }

      this.handler(`${file} loaded\n`)
      let fileCulture: string
      let fileName: string
      let cultureFromPath = fileHelper.getCultureFromPath(file)
      if (cultureFromPath) {
        fileCulture = cultureFromPath
        let fileNameWithCulture = path.basename(file, path.extname(file))
        fileName = fileNameWithCulture.substring(0, fileNameWithCulture.length - fileCulture.length - 1)
      } else {
        fileCulture = culture
        fileName = path.basename(file, path.extname(file))
      }

      const fileFolder = path.dirname(file)
      const multiRecognizerPath = path.join(fileFolder, `${fileName}.qna.dialog`)
      if (!multiRecognizers.has(fileName)) {
        let multiRecognizerContent = {}
        if (fs.existsSync(multiRecognizerPath)) {
          multiRecognizerContent = JSON.parse(await fileHelper.getContentFromFile(multiRecognizerPath)).recognizers
          this.handler(`${multiRecognizerPath} loaded\n`)
        }

        multiRecognizers.set(fileName, new MultiLanguageRecognizer(multiRecognizerPath, multiRecognizerContent))
      }

      const settingsPath = path.join(fileFolder, `qnamaker.settings.${suffix}.${region}.json`)
      if (!settings.has(fileFolder)) {
        let settingsContent = {}
        if (fs.existsSync(settingsPath)) {
          settingsContent = JSON.parse(await fileHelper.getContentFromFile(settingsPath)).qnamaker
          this.handler(`${settingsPath} loaded\n`)
        }

        settings.set(fileFolder, new Settings(settingsPath, settingsContent))
      }

      const content = new Content(fileContent, new LUOptions(fileName, true, fileCulture, file))
      qnaContents.push(content)

      const dialogFile = path.join(fileFolder, `${content.name}.dialog`)
      let existingDialogObj: any
      if (fs.existsSync(dialogFile)) {
        existingDialogObj = JSON.parse(await fileHelper.getContentFromFile(dialogFile))
        this.handler(`${dialogFile} loaded\n`)
      }

      let recognizer = Recognizer.load(content.path, content.name, dialogFile, settings.get(fileFolder) as Settings, existingDialogObj)
      recognizers.set(content.name, recognizer)
    }

    // validate if there are duplicated files with same name and locale
    let setOfContents = new Set()
    const hasDuplicates = qnaContents.some(function (currentObj) {
      return setOfContents.size === setOfContents.add(currentObj.name).size
    })

    if (hasDuplicates) {
      throw(new exception(retCode.errorCode.INVALID_INPUT_FILE, 'Files with same name and locale are found.'))
    }

    return {qnaContents, recognizers, multiRecognizers, settings}
  }

  async build(
    qnaContents: any[],
    recognizers: Map<string, Recognizer>,
    subscriptionkey: string,
    endpoint: string,
    botName: string,
    suffix: string,
    fallbackLocale: string,
    multiRecognizers?: Map<string, MultiLanguageRecognizer>,
    settings?: Map<string, Settings>) {
    // qna api TPS which means concurrent transactions to qna maker api in 1 second
    let qnaApiTps = 3

    // set qna maker call delay duration to 1100 millisecond because 1000 can hit corner case of rate limit
    let delayDuration = 1100

    const qnaBuildCore = new QnaBuildCore(subscriptionkey, endpoint)
    const kbs = (await qnaBuildCore.getKBList()).knowledgebases

    // here we do a while loop to make full use of qna tps capacity
    while (qnaContents.length > 0) {
      // get a number(set by luisApiTps) of contents for each loop
      const subQnaContents = qnaContents.splice(0, qnaApiTps)

      // concurrently handle applications
      await Promise.all(subQnaContents.map(async content => {
        // init current kb object from qna content
        const qnaObj = await this.initQnaFromContent(content, botName, suffix)
        let currentKB = qnaObj.kb
        let currentAlt = qnaObj.alterations
        let culture = content.language as string

        // get recognizer
        let recognizer = recognizers.get(content.name) as Recognizer

        // find if there is a matched name with current kb under current authoring key
        if (!recognizer.getKBId()) {
          for (let kb of kbs) {
            if (kb.name === currentKB.name) {
              recognizer.setKBId(kb.id)
              break
            }
          }
        }

        let needPublish = false

        // compare models to update the model if a match found
        // otherwise create a new kb
        if (recognizer.getKBId() && recognizer.getKBId() !== '') {
          // To see if need update the model
          needPublish = await this.updateKB(currentKB, qnaBuildCore, recognizer, delayDuration)
        } else {
          // create a new kb
          needPublish = await this.createKB(currentKB, qnaBuildCore, recognizer, delayDuration)
        }

        if (needPublish) {
          // train and publish kb
          await this.publishKB(qnaBuildCore, recognizer, delayDuration)
        }

        // update alterations if there are
        if (currentAlt.wordAlterations && currentAlt.wordAlterations.length > 0) {
          this.handler(`${recognizer.getQnaPath()} replacing alterations...\n`)
          await qnaBuildCore.replaceAlt(currentAlt)
        }

        // update multiLanguageRecognizer asset
        if (multiRecognizers && multiRecognizers.has(content.id)) {
          let multiRecognizer = multiRecognizers.get(content.id) as MultiLanguageRecognizer
          multiRecognizer.recognizers[culture] = path.basename(recognizer.getDialogPath(), '.dialog')
          if (culture.toLowerCase() === fallbackLocale.toLowerCase()) {
            multiRecognizer.recognizers[''] = path.basename(recognizer.getDialogPath(), '.dialog')
          }
        }

        // update settings asset
        if (settings && settings.has(path.dirname(content.path))) {
          let setting = settings.get(path.dirname(content.path)) as Settings
          setting.qnamaker[content.name.split('.').join('_')] = recognizer.getKBId()
        }
      }))
    }

    // write dialog assets
    let recognizerValues: Recognizer[] = []
    if (recognizers) {
      recognizerValues = Array.from(recognizers.values())
    }

    let multiRecognizerValues: MultiLanguageRecognizer[] = []
    if (multiRecognizers) {
      multiRecognizerValues = Array.from(multiRecognizers.values())
    }

    let settingValues: Settings[] = []
    if (settings) {
      settingValues = Array.from(settings.values())
    }

    const dialogContents = qnaBuildCore.generateDeclarativeAssets(recognizerValues, multiRecognizerValues, settingValues)

    return dialogContents
  }

  async writeDialogAssets(contents: any[], force: boolean, out: string) {
    let writeDone = false

    let writeContents = contents.filter(c => c.id.endsWith('.dialog'))
    let settingsContents = contents.filter(c => c.id.endsWith('.json'))

    if (out) {
      const outPath = path.join(path.resolve(out), settingsContents[0].id)
      writeContents.push(this.mergeSettingsContent(outPath, settingsContents))
    } else {
      writeContents = writeContents.concat(settingsContents)
    }

    if (out) {
      for (const content of writeContents) {
        const outFilePath = path.join(path.resolve(out), path.basename(content.path))
        if (force || !fs.existsSync(outFilePath)) {
          this.handler(`Writing to ${outFilePath}\n`)
          await fs.writeFile(outFilePath, content.content, 'utf-8')
          writeDone = true
        }
      }
    } else {
      for (const content of writeContents) {
        if (force || !fs.existsSync(content.path)) {
          this.handler(`Writing to ${content.path}\n`)
          await fs.writeFile(content.path, content.content, 'utf-8')
          writeDone = true
        }
      }
    }

    return writeDone
  }

  async initQnaFromContent(content: any, botName: string, suffix: string) {
    let currentQna = await JSON.parse(content.content)
    if (!currentQna.kb.name) currentQna.kb.name = `${botName}(${suffix})-${content.name}`

    return {kb: currentQna.kb, alterations: currentQna.alterations}
  }

  async updateKB(currentKB: any, qnaBuildCore: QnaBuildCore, recognizer: Recognizer, delayDuration: number) {
    await delay(delayDuration)
    const existingKB = await qnaBuildCore.exportKB(recognizer.getKBId(), 'Prod')
    const existingIds = (existingKB.qnaDocuments || []).map((document: any) => document.id)

    // compare models
    const isKBEqual = qnaBuildCore.isKBEqual(currentKB, existingKB)
    if (!isKBEqual) {
      const newKB = {
        delete: {
          ids: existingIds
        },
        add: {
          qnaList: currentKB.qnaList,
          urls: currentKB.urls,
          files: currentKB.files
        },
        update: {
          urls: currentKB.urls,
        }
      }

      this.handler(`${recognizer.getQnaPath()} updating to new version...\n`)
      await delay(delayDuration)
      const response = await qnaBuildCore.updateKB(recognizer.getKBId(), newKB)
      const operationId = response.operationId
      await this.getKBOperationStatus(qnaBuildCore, operationId, delayDuration)
      this.handler(`${recognizer.getQnaPath()} updating finished\n`)

      return true
    } else {
      this.handler(`${recognizer.getQnaPath()} no changes\n`)
      return false
    }
  }

  async createKB(currentKB: any, qnaBuildCore: QnaBuildCore, recognizer: Recognizer, delayDuration: number) {
    this.handler(`${recognizer.getQnaPath()} creating qnamaker KB: ${currentKB.name}...\n`)
    await delay(delayDuration)
    const response = await qnaBuildCore.importKB(currentKB)
    const operationId = response.operationId

    const opResult = await this.getKBOperationStatus(qnaBuildCore, operationId, delayDuration)
    recognizer.setKBId(opResult.resourceLocation.split('/')[2])
    this.handler(`${recognizer.getQnaPath()} creating finished\n`)

    return true
  }

  async getKBOperationStatus(qnaBuildCore: QnaBuildCore, operationId: string, delayDuration: number) {
    let opResult
    let isGetting = true
    while (isGetting) {
      await delay(delayDuration)
      opResult = await qnaBuildCore.getOperationStatus(operationId)

      if (opResult.operationState === 'Failed') {
        throw new Error(JSON.stringify(opResult, null, 4))
      }

      if (opResult.operationState === 'Succeeded') isGetting = false
    }

    return opResult
  }

  async publishKB(qnaBuildCore: QnaBuildCore, recognizer: Recognizer, delayDuration: number) {
    // publish applications
    this.handler(`${recognizer.getQnaPath()} publishing...\n`)
    await delay(delayDuration)
    await qnaBuildCore.publishKB(recognizer.getKBId())
    this.handler(`${recognizer.getQnaPath()} publishing finished\n`)
  }

  mergeSettingsContent(settingsPath: string, contents: any[]) {
    let settings = new Settings(settingsPath, {})
    for (const content of contents) {
      const qnaMakerKBsMap = JSON.parse(content.content).qnamaker
      for (const kbName of Object.keys(qnaMakerKBsMap)) {
        settings.qnamaker[kbName] = qnaMakerKBsMap[kbName]
      }
    }

    return new Content(settings.save(), new LUOptions(path.basename(settings.getSettingsPath()), true, '', settings.getSettingsPath()))
  }
}