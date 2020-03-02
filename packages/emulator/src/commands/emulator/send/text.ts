import {Command, flags} from '@oclif/command'

export default class EmulatorSendText extends Command {
  static description = 'describe the command here'

  static flags = {
    help: flags.help({char: 'h'}),
    text: flags.string({char: 't', description: 'text to send to the bot'}),
  }

  async run() {
    const {flags} = this.parse(EmulatorSendText)
    
  }
}
