import {expect, test} from '@oclif/test'

describe('emulator:send:text', () => {
  test
  .stdout()
  .command(['emulator:send:text'])
  .it('runs hello', ctx => {
    expect(ctx.stdout).to.contain('hello world')
  })

  test
  .stdout()
  .command(['emulator:send:text', '--name', 'jeff'])
  .it('runs hello --name jeff', ctx => {
    expect(ctx.stdout).to.contain('hello jeff')
  })
})
