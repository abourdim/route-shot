const puppeteer = require('puppeteer'); // v23.0.0 or later

(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    const timeout = 5000;
    page.setDefaultTimeout(timeout);

    {
        const targetPage = page;
        await targetPage.setViewport({
            width: 3453,
            height: 1588
        })
    }
    {
        const targetPage = page;
        await targetPage.goto('https://abourdim.github.io/bit-playground/#tab=senses');
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('#controlsTabBtn > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"controlsTabBtn\\"]/span[2])'),
            targetPage.locator(':scope >>> #controlsTabBtn > span:nth-of-type(2)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 2.11572265625,
                y: 15.13751220703125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('#sensesTabBtn > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"sensesTabBtn\\"]/span[2])'),
            targetPage.locator(':scope >>> #sensesTabBtn > span:nth-of-type(2)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 13.218505859375,
                y: 11.13751220703125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('#servosTabBtn > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"servosTabBtn\\"]/span[2])'),
            targetPage.locator(':scope >>> #servosTabBtn > span:nth-of-type(2)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 2.025634765625,
                y: 15.13751220703125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('#gamepadTabBtn > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"gamepadTabBtn\\"]/span[2])'),
            targetPage.locator(':scope >>> #gamepadTabBtn > span:nth-of-type(2)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 13.0401611328125,
                y: 7.13751220703125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('::-p-aria(📈 Graph)'),
            targetPage.locator('#graphTabBtn'),
            targetPage.locator('::-p-xpath(//*[@id=\\"graphTabBtn\\"])'),
            targetPage.locator(':scope >>> #graphTabBtn'),
            targetPage.locator('::-p-text(📈\n                     )')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 111.1944580078125,
                y: 38.58416748046875,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('#board3dTabBtn > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"board3dTabBtn\\"]/span[2])'),
            targetPage.locator(':scope >>> #board3dTabBtn > span:nth-of-type(2)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 1.3935546875,
                y: 12.13751220703125,
              },
            });
    }
    {
        const targetPage = page;
        await puppeteer.Locator.race([
            targetPage.locator('#othersTabBtn > span:nth-of-type(2)'),
            targetPage.locator('::-p-xpath(//*[@id=\\"othersTabBtn\\"]/span[2])'),
            targetPage.locator(':scope >>> #othersTabBtn > span:nth-of-type(2)'),
            targetPage.locator('::-p-text(More)')
        ])
            .setTimeout(timeout)
            .click({
              offset: {
                x: 19.132568359375,
                y: 16.13751220703125,
              },
            });
    }

    await browser.close();

})().catch(err => {
    console.error(err);
    process.exit(1);
});
