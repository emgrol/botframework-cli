/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {CLIError, Command, flags} from '@microsoft/bf-cli-command'

const utils = require('../../../utils/index')

export default class LuisApplicationList extends Command {
  static description = 'Lists all applications on LUIS service.'

  static examples = [`
    $ bf luis:application:list --endpoint {ENDPOINT} --subscriptionKey {SUBSCRIPTION_KEY} --take 3
    $ bf luis:application:list --endpoint {ENDPOINT} --subscriptionKey {SUBSCRIPTION_KEY} --out {PATH_TO_JSON_FILE}
  `]

  static flags: any = {
    help: flags.help({char: 'h'}),
    endpoint: flags.string({description: 'LUIS endpoint hostname'}),
    subscriptionKey: flags.string({description: 'LUIS cognitive services subscription key (aka Ocp-Apim-Subscription-Key)'}),
    out: flags.string({char: 'o', description: 'Path to the directory where the exported file will be placed.'}),
    force: flags.boolean({char: 'f', description: 'If --out flag is provided with the path to an existing file, overwrites that file', default: false}),
    skip: flags.string({description: 'The number of entries to skip. The default is 0 (no skips)'}),
    take: flags.string({description: 'The number of etnries to return. The maximum page size is 500. The default is 100.'}),
  }

  async run() {
    const {flags} = this.parse(LuisApplicationList)
    const flagLabels = Object.keys(LuisApplicationList.flags)
    const configDir = this.config.configDir
    const options: any = {}

    let {endpoint, subscriptionKey, force, out, skip, take} = await utils.processInputs(flags, flagLabels, configDir)

    const requiredProps = {endpoint, subscriptionKey}
    utils.validateRequiredProps(requiredProps)

    const client = utils.getLUISClient(subscriptionKey, endpoint)

    if (skip) options.skip = parseInt(skip, 10)
    if (take) options.take = parseInt(take, 10)

    try {
      const appList = await client.apps.list(options, undefined)
      if (out) {
        const writtenFilePath: string = await utils.writeToFile(out, appList, force)
        this.log(`\nList successfully written to file: ${writtenFilePath}`)
      } else {
        await utils.writeToConsole(appList)
        this.log('\nList successfully output to console')
      }
    } catch (err) {
      throw new CLIError(`Failed to export application list: ${err}`)
    }
  }

}