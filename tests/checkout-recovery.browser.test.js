import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";

const base=process.env.CLIPONAUT_UI_TEST_URL||"http://127.0.0.1:3219";
if(!["127.0.0.1","localhost"].includes(new URL(base).hostname))throw Error("Local isolated UI server required");

for(const [name,viewport] of [["desktop",{width:1440,height:1000}],["mobile",{width:390,height:844}]]) {
  test(`${name}: unresolved checkout shows support and disables repeat attempts without navigation`,async()=>{
    const browser=await chromium.launch({headless:true,...(process.env.CLIPONAUT_BROWSER_CHANNEL?{channel:process.env.CLIPONAUT_BROWSER_CHANNEL}:{})});
    let checkoutAttempts=0,unexpectedMutations=0;
    try {
      const context=await browser.newContext({viewport});
      await context.route("**/*",async route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.origin!==new URL(base).origin)return route.abort();
        if(url.pathname==="/api/billing/dodo/customer-checkout"&&request.method()==="POST") {
          checkoutAttempts++;
          return route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({code:"checkout_reconciliation_required",error:"Your earlier checkout needs a payment-status review before you can try again. Contact checkout support so we can check it safely."})});
        }
        if(!["GET","HEAD"].includes(request.method())){unexpectedMutations++;return route.abort();}
        if(!url.pathname.startsWith("/api/"))return route.continue();
        const account={signedIn:true,email:"synthetic-customer@example.test",subscriptionStatus:"not_subscribed",cancellation:{enabled:false,state:"none",periodEnd:null}};
        const usage={allowance:15,billingPeriod:null,successfulRenders:null,reservedRenders:null,remainingRenders:null,founderUnlimited:false};
        const body=url.pathname==="/api/auth/session"?account:url.pathname==="/api/account/usage"?usage:{};
        return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
      });
      const page=await context.newPage();
      await page.goto(`${base}/account`);
      await page.getByRole("heading",{name:"synthetic-customer@example.test"}).waitFor();
      await page.getByRole("button",{name:"Continue to checkout",exact:true}).click();
      await page.getByRole("alert").filter({hasText:"earlier checkout"}).waitFor();
      assert.equal(await page.getByRole("button",{name:"Checkout needs review",exact:true}).isDisabled(),true);
      assert.equal(checkoutAttempts,1);assert.equal(new URL(page.url()).pathname,"/account");
      assert.equal(await page.getByRole("link",{name:"Contact checkout support",exact:true}).getAttribute("href"),"/contact");
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.getByRole("link",{name:"Contact checkout support",exact:true}).click();
      await page.getByRole("heading",{name:"Checkout and payment help",exact:true}).waitFor();
      assert.equal(await page.locator('a[href="mailto:cliponauthq@gmail.com"]').count()>0,true);
      assert.equal(checkoutAttempts,1);assert.equal(unexpectedMutations,0);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }finally{await browser.close();}
  });
}
